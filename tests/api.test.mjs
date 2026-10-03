/**
 * 自建 App 网关测试
 *
 * 覆盖：Token 鉴权（401/常量时间比较入口）、静态页、/chat 入队
 * （enqueue 用注入的 spy，不真跑模型）、/history、SSE 流
 * （answer 事件按 chatId 过滤后到达客户端）。
 * 不碰 better-sqlite3，本地可跑。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createAppApiServer } from "../src/channels/api.mjs";
import { emit } from "../src/events.mjs";

const CHAT = "app-test";
const jobs = [];
const { server } = createAppApiServer({
  token: "tk-1",
  chatId: CHAT,
  html: "<html><body>ok-page</body></html>",
  enqueue: (job) => jobs.push(job),
  history: (limit) => [{ role: "user", content: `历史 ${limit}` }],
});
after(() => server.close());

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const H = { Authorization: "Bearer tk-1", "Content-Type": "application/json" };

test("静态页不需要 Token", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /ok-page/);
});

test("manifest 可获取", async () => {
  const r = await fetch(base + "/manifest.webmanifest");
  assert.equal(r.status, 200);
  const m = await r.json();
  assert.equal(m.short_name, "Erifane");
});

test("没有 Token：/chat 和 /history 一律 401", async () => {
  assert.equal((await fetch(base + "/chat", { method: "POST" })).status, 401);
  assert.equal((await fetch(base + "/history")).status, 401);
});

test("Token 错误也是 401", async () => {
  const r = await fetch(base + "/chat", {
    method: "POST",
    headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(r.status, 401);
});

test("/chat：合法请求入队，chatId 和文本正确", async () => {
  const r = await fetch(base + "/chat", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ text: "  帮我总结视频  ", messageId: "m-1" }),
  });
  assert.equal(r.status, 202);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].chatId, CHAT);
  assert.equal(jobs[0].text, "帮我总结视频");
});

test("/chat：空文本 400，坏 JSON 400", async () => {
  assert.equal(
    (await fetch(base + "/chat", { method: "POST", headers: H, body: JSON.stringify({ text: " " }) })).status,
    400,
  );
  assert.equal(
    (await fetch(base + "/chat", { method: "POST", headers: H, body: "not-json" })).status,
    400,
  );
});

test("/history：返回注入的历史函数结果", async () => {
  const r = await fetch(base + "/history?limit=7", { headers: H });
  const { messages } = await r.json();
  assert.match(messages[0].content, /历史 7/);
});

test("SSE：answer 事件按 chatId 过滤后推给客户端", async () => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  const resp = await fetch(base + "/stream?t=tk-1", { signal: ac.signal });
  assert.equal(resp.status, 200);

  // 等订阅生效，然后各发一条：本会话的 answer 应到达，别的会话的不应到达
  await new Promise((r) => setTimeout(r, 50));
  emit("answer", { chatId: "other-chat", text: "不该收到" });
  emit("answer", { chatId: CHAT, text: "该收到" });

  const reader = resp.body.getReader();
  let buf = "";
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !buf.includes("该收到")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
  }
  clearTimeout(timer);
  ac.abort();

  assert.match(buf, /event: answer/);
  assert.match(buf, /该收到/);
  assert.ok(!buf.includes("不该收到"), "别的会话的事件绝不能漏进来");
});
