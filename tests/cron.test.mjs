/**
 * cron 解析器测试
 *
 * 重点覆盖「日 / 周」那个经典陷阱 —— 这是最容易写错、
 * 而且错了很难发现（表现为"每天都触发"）的地方。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, matches } from "../src/scheduler/cron.mjs";

const at = (iso) => new Date(iso);

// 参考日历（2026 年 9 月）：
//   09-14 周一   09-15 周二   09-16 周三   09-25 周五   09-26 周六

test("基本：每天 08:00", () => {
  const c = parseCron("0 8 * * *");
  assert.equal(matches(c, at("2026-09-25T08:00:00")), true);
  assert.equal(matches(c, at("2026-09-25T08:01:00")), false, "分钟不对");
  assert.equal(matches(c, at("2026-09-25T07:59:00")), false, "早一分钟");
});

test("步长：每 30 分钟", () => {
  const c = parseCron("*/30 * * * *");
  assert.equal(matches(c, at("2026-09-25T10:00:00")), true);
  assert.equal(matches(c, at("2026-09-25T10:30:00")), true);
  assert.equal(matches(c, at("2026-09-25T10:31:00")), false);
});

test("列表：每天 10 点和 15 点", () => {
  const c = parseCron("0 10,15 * * *");
  assert.equal(matches(c, at("2026-09-25T10:00:00")), true);
  assert.equal(matches(c, at("2026-09-25T15:00:00")), true);
  assert.equal(matches(c, at("2026-09-25T11:00:00")), false);
});

test("范围：工作日 09:30", () => {
  const c = parseCron("30 9 * * 1-5");
  assert.equal(matches(c, at("2026-09-25T09:30:00")), true, "周五应命中");
  assert.equal(matches(c, at("2026-09-26T09:30:00")), false, "周六不该命中");
});

test("★ 陷阱：只限制「日」时，「周」不能干扰它", () => {
  // 这条最容易被写成 dom.has(d) || dow.has(d) —— 那会导致每天都触发
  const c = parseCron("0 9 15 * *"); // 每月 15 号
  assert.equal(matches(c, at("2026-09-15T09:00:00")), true, "15 号命中");
  assert.equal(
    matches(c, at("2026-09-14T09:00:00")),
    false,
    "不是 15 号就不该命中（哪怕它是周一）",
  );
});

test("★ 陷阱：「日」和「周」都被限制时，是【或】关系", () => {
  const c = parseCron("0 9 15 * 1"); // 每月 15 号 或 每周一
  assert.equal(matches(c, at("2026-09-15T09:00:00")), true, "15 号（周二）命中");
  assert.equal(matches(c, at("2026-09-14T09:00:00")), true, "周一命中");
  assert.equal(matches(c, at("2026-09-16T09:00:00")), false, "16 号（周三）不命中");
});

test("★ 陷阱：两个都是 * 时，每天都匹配", () => {
  const c = parseCron("0 9 * * *");
  assert.equal(matches(c, at("2026-09-15T09:00:00")), true);
  assert.equal(matches(c, at("2026-09-16T09:00:00")), true);
  assert.equal(matches(c, at("2026-10-01T09:00:00")), true);
});

test("月份限制", () => {
  const c = parseCron("0 9 1 1 *"); // 每年 1 月 1 日
  assert.equal(matches(c, at("2027-01-01T09:00:00")), true);
  assert.equal(matches(c, at("2027-02-01T09:00:00")), false);
});

test("非法输入应该抛错，而不是静默通过", () => {
  assert.throws(() => parseCron("0 8 * *"), /5 段/, "段数不对");
  assert.throws(() => parseCron("0 8 * * * *"), /5 段/, "段数过多");
  assert.throws(() => parseCron("0 8 * * abc"), /看不懂/, "非法字段");
  assert.throws(() => parseCron("*/0 * * * *"), /步长/, "步长不能为 0");
});