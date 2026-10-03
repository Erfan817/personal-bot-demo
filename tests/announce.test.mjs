/**
 * 过程通知截断测试
 *
 * 背景：字幕工具一返回就是上万字符，原样进 tool_call 事件会把
 * 聊天窗口刷屏（真实踩过：用户收到整段字幕而非总结）。
 * 钉住的行为：长结果只保留开头 + 长度提示；短结果原样通过。
 *
 * 纯 JS，本地可跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateForAnnounce, ANNOUNCE_RESULT_LIMIT } from "../src/brain/announce.mjs";

test("短结果原样通过，不做任何加工", () => {
  assert.equal(truncateForAnnounce("✅ 已创建提醒"), "✅ 已创建提醒");
  assert.equal(truncateForAnnounce(""), "");
  assert.equal(truncateForAnnounce(null), "", "空值归一为空串");
});

test("长结果截断到上限，并标注总长度", () => {
  const long = "字".repeat(10000);
  const out = truncateForAnnounce(long);
  assert.ok(out.length < ANNOUNCE_RESULT_LIMIT + 60, "截断后必须远短于原文");
  assert.ok(out.startsWith("字".repeat(ANNOUNCE_RESULT_LIMIT)));
  assert.match(out, /共 10000 字符/);
  assert.match(out, /已交给模型处理/);
});

test("恰好等于上限的结果不截断", () => {
  const exact = "a".repeat(ANNOUNCE_RESULT_LIMIT);
  assert.equal(truncateForAnnounce(exact), exact);
});

test("自定义上限生效", () => {
  const out = truncateForAnnounce("abcdef", 3);
  assert.ok(out.startsWith("abc"));
  assert.match(out, /共 6 字符/);
});
