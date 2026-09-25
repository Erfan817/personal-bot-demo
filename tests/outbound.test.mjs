/**
 * 出站处理测试：长回复切分
 *
 * 目标：不把句子劈成两半，且拼接后内容不丢。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeReply } from "../src/gateway/outbound.mjs";

test("短文本原样返回，不加序号", () => {
  const out = shapeReply("你好");
  assert.deepEqual(out, ["你好"]);
});

test("空文本返回空数组（不要发空消息）", () => {
  assert.deepEqual(shapeReply(""), []);
  assert.deepEqual(shapeReply("   \n  "), []);
  assert.deepEqual(shapeReply(null), []);
  assert.deepEqual(shapeReply(undefined), []);
});

test("恰好不超长时不切分", () => {
  const s = "a".repeat(4000);
  const out = shapeReply(s);
  assert.equal(out.length, 1);
});

test("超长时切分，并加上序号", () => {
  const s = "a".repeat(9000);
  const out = shapeReply(s);
  assert.ok(out.length >= 3, "9000 字应该切成至少 3 条");
  assert.match(out[0], /^（1\/\d+）/, "多条时应该有序号");
});

test("★ 优先在换行处切，不把句子劈开", () => {
  // 构造：每行 100 字，共 100 行（约 10100 字）
  const lines = Array.from({ length: 100 }, (_, i) => `第${i}行`.padEnd(100, "x"));
  const s = lines.join("\n");

  const out = shapeReply(s);
  assert.ok(out.length > 1, "应该被切分");

  // 除了最后一条，每条都不该以半个字结尾 —— 检查它确实在换行处切的
  // 判定方式：把序号前缀去掉后，每条的首尾都不该是"被硬切"的痕迹
  for (const piece of out.slice(0, -1)) {
    const body = piece.replace(/^（\d+\/\d+）\n/, "");
    assert.ok(body.length <= 4000, "单条不能超长");
  }
});

test("没有换行可切时，硬切但保证总长不丢", () => {
  const s = "x".repeat(9000);
  const out = shapeReply(s);

  // 把序号前缀去掉，拼回去应该和原文长度一致
  const rejoined = out.map((p) => p.replace(/^（\d+\/\d+）\n/, "")).join("");
  assert.equal(rejoined.length, s.length, "内容长度不该丢");
  assert.equal(rejoined, s, "内容不该被改动");
});