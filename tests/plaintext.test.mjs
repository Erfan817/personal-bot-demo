/**
 * 出站纯文本转换测试（Markdown 剥离）
 *
 * 背景：模型天生输出 Markdown，飞书/终端不渲染 —— 星号裸露。
 * 钉住的行为：加粗/标题/代码/链接/星号列表被剥掉；
 * 乘法表达 "3 * 4" 这类【不能】被误伤；纯文本原样通过。
 * 纯 JS，本地可跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlainText } from "../src/gateway/outbound.mjs";

test("加粗标记被剥掉，保留内容", () => {
  assert.equal(toPlainText("**核心结论**：要算三笔账"), "核心结论：要算三笔账");
  assert.equal(toPlainText("a **b** c **d** e"), "a b c d e");
});

test("标题的 # 被剥掉", () => {
  assert.equal(toPlainText("## 一、事件与数字"), "一、事件与数字");
  assert.equal(toPlainText("### 小节\n正文"), "小节\n正文");
});

test("行内代码与代码围栏标记被剥掉", () => {
  assert.equal(toPlainText("用 `FTS5` 检索"), "用 FTS5 检索");
  assert.equal(
    toPlainText("```python\nprint(1)\n```"),
    "print(1)",
  );
});

test("Markdown 链接转成 文字（地址）", () => {
  assert.equal(
    toPlainText("[bilibili](https://www.bilibili.com)"),
    "bilibili（https://www.bilibili.com）",
  );
});

test("星号列表转间隔点；破折号列表保留", () => {
  assert.equal(toPlainText("* 第一条\n* 第二条"), "· 第一条\n· 第二条");
  assert.equal(toPlainText("- 第一条"), "- 第一条");
});

test("★ 乘法表达不能被误伤", () => {
  assert.equal(toPlainText("123 * 456 = 5607"), "123 * 456 = 5607");
  assert.equal(toPlainText("3 * 4 * 5"), "3 * 4 * 5");
});

test("引用与分隔线被清理，多余空行被压缩", () => {
  assert.equal(toPlainText("> 引用的话"), "引用的话");
  assert.equal(toPlainText("上\n\n---\n\n下"), "上\n\n下");
  assert.equal(toPlainText("a\n\n\n\nb"), "a\n\nb");
});

test("纯文本原样通过", () => {
  const plain = "1. 先说结论\n2. 再算账\n完";
  assert.equal(toPlainText(plain), plain);
});
