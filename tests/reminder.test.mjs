/**
 * 提醒任务内核测试（remind_me 工具的纯函数部分）
 *
 * 覆盖三个容易翻车的地方：
 *   1. upsert 同名覆盖 —— 「把提醒改到 8 点」必须是更新而不是重复建
 *   2. remove 删不到时的返回值 —— 上层要靠它给出「现有的有哪些」
 *   3. describeCron 翻译宁缺毋滥 —— 日期/月份相关的宁可回退原文，不可翻错
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron } from "../src/scheduler/cron.mjs";
import { describeCron, upsertJob, removeJob } from "../src/tools/lib/reminder.mjs";

/* ══════════════════ upsertJob ══════════════════ */

test("upsertJob：新名字是追加", () => {
  const r = upsertJob([], { name: "背单词", cron: "0 21 * * *" });
  assert.equal(r.replaced, false);
  assert.equal(r.jobs.length, 1);
});

test("upsertJob：同名是替换，不是重复建", () => {
  const base = [{ name: "背单词", cron: "0 21 * * *" }];
  const r = upsertJob(base, { name: "背单词", cron: "0 20 * * *" });
  assert.equal(r.replaced, true, "「把提醒改到 8 点」应该走更新");
  assert.equal(r.jobs.length, 1, "不能变成两个同名任务");
  assert.equal(r.jobs[0].cron, "0 20 * * *");
});

test("upsertJob：不同名字互不干扰", () => {
  const base = [{ name: "早报", cron: "0 8 * * *" }];
  const r = upsertJob(base, { name: "背单词", cron: "0 21 * * *" });
  assert.equal(r.replaced, false);
  assert.equal(r.jobs.length, 2);
  assert.equal(r.jobs[0].name, "早报");
});

/* ══════════════════ removeJob ══════════════════ */

test("removeJob：删得到", () => {
  const base = [
    { name: "早报", cron: "0 8 * * *" },
    { name: "背单词", cron: "0 21 * * *" },
  ];
  const r = removeJob(base, "背单词");
  assert.equal(r.removed, true);
  assert.deepEqual(r.jobs.map((j) => j.name), ["早报"]);
});

test("removeJob：删不到要如实报告（上层据此列出现有的）", () => {
  const r = removeJob([{ name: "早报" }], "不存在的");
  assert.equal(r.removed, false);
  assert.equal(r.jobs.length, 1, "原清单不能被动");
});

/* ══════════════════ describeCron ══════════════════ */

test("describeCron：每天固定时间", () => {
  assert.equal(describeCron(parseCron("0 21 * * *")), "每天 21:00");
  assert.equal(describeCron(parseCron("30 7 * * *")), "每天 07:30");
});

test("describeCron：每周几（含周日=0）", () => {
  assert.equal(describeCron(parseCron("0 9 * * 0")), "每周日 09:00");
  assert.equal(
    describeCron(parseCron("30 7 * * 1-5")),
    "每周一、周二、周三、周四、周五 07:30",
  );
});

test("describeCron：一天多次", () => {
  assert.equal(describeCron(parseCron("0 8,21 * * *")), "每天 08:00、21:00");
});

test("describeCron：日期/月份相关的翻不动，返回 null 交给原文", () => {
  assert.equal(describeCron(parseCron("0 9 15 * *")), null, "指定了日期");
  assert.equal(describeCron(parseCron("0 9 * 6 *")), null, "指定了月份");
  assert.equal(describeCron(parseCron("0 9 15 6 *")), null, "日期+月份");
});

test("describeCron：dom 和 dow 同时受限是【或】关系，人话说不清，回退", () => {
  assert.equal(describeCron(parseCron("0 9 1 * 1")), null);
});

test("describeCron：空输入不炸", () => {
  assert.equal(describeCron(null), null);
});
