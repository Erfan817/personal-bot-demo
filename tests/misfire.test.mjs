/**
 * misfire 扫描测试
 *
 * 「8 点提醒我吃药，服务 7:58-8:20 重启」这种场景，提醒必须补发；
 * 而正常 tick 处理过的分钟、以及当前分钟，绝不能重复算成错过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron } from "../src/scheduler/cron.mjs";
import { scanMissed } from "../src/scheduler/misfire.mjs";

const j = (name, cron, enabled = true) => ({
  name,
  enabled,
  cronParsed: parseCron(cron),
});

// 2026-09-25（周五）北京时间 —— matches 用本地时间，测试机也是 +08:00
const at = (h, m) => new Date(2026, 8, 25, h, m, 0, 0).getTime();

test("★ 重启跨过触发分钟：时间窗内的那一次要被找到", () => {
  const jobs = [j("吃药提醒", "0 8 * * *")];
  // 上次 tick 07:58，现在 08:20 —— 08:00 那一分钟在窗内
  const found = scanMissed(jobs, at(7, 58), at(8, 20));
  assert.equal(found.size, 1);
  assert.equal(found.get(jobs[0]), at(8, 0));
});

test("上次 tick 已处理过的分钟不算错过（防重复补发）", () => {
  const jobs = [j("吃药提醒", "0 8 * * *")];
  // tick 在 08:00:02 跑过然后进程死了 —— 08:00:00 在 from 之前，不扫
  const from = at(8, 0) + 2000;
  const found = scanMissed(jobs, from, at(8, 20));
  assert.equal(found.size, 0);
});

test("当前分钟不扫，交给正常 tick（防二次触发）", () => {
  const jobs = [j("每天09:00", "0 9 * * *")];
  // 窗口右端正好是 09:00（当前分钟）—— 必须排除，否则正常 tick 会二次触发
  assert.equal(scanMissed(jobs, at(8, 0), at(9, 0)).size, 0);
  // 对照：窗口一旦越过 09:00，它就该被当成错过了
  const found = scanMissed(jobs, at(8, 0), at(9, 1));
  assert.equal(found.get(jobs[0]), at(9, 0));
});

test("只保留最近一次错过（挂了三天也不刷屏）", () => {
  const jobs = [j("每小时", "0 * * * *")];
  const found = scanMissed(jobs, at(0, 0), at(23, 30));
  assert.equal(found.get(jobs[0]), at(23, 0), "窗口内多次命中只留最近一次");
});

test("窗口上限：超过 capMinutes 的老错过不补", () => {
  const jobs = [j("每天07:30", "30 7 * * *"), j("每天08:00", "0 8 * * *")];
  const to = at(9, 0);
  const found = scanMissed(jobs, to - 48 * 60 * 60 * 1000, to, 60);
  assert.equal(found.has(jobs[0]), false, "07:30 在 60 分钟窗外，不补");
  assert.equal(found.get(jobs[1]), at(8, 0), "08:00 在窗内，补");
});

test("停用的任务和空窗口不参与", () => {
  const jobs = [j("停用的", "0 8 * * *", false)];
  assert.equal(scanMissed(jobs, at(7, 0), at(9, 0)).size, 0);
  assert.equal(scanMissed(jobs, at(9, 0), at(8, 0)).size, 0, "to<=from 直接空");
});
