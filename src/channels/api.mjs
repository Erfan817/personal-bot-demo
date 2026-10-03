/**
 * 协议层 · 自建 App 网关（PWA 手机端）
 * ═══════════════════════════════════════════════════
 * 给自己的手机 App 当后端。和飞书渠道做的是同两件事：
 *   收消息：POST /chat（带 Token）→ 过闸门 → 入全局串行队列
 *   发消息：GET /stream（SSE）→ 按 chatId 推 answer / 过程 / 定时推送
 *
 * 设计决定：
 *   · 鉴权 = 共享 Token（Bearer）。个人工具不搞账号体系，
 *     但公网上【没有 Token 就没有这个端口】——见 config.appApi.host 默认 127.0.0.1
 *   · SSE 而不是 WebSocket：node:http 内置就能做，零新依赖；
 *     手机 → 服务器走 POST，服务器 → 手机走 SSE，方向刚好对上
 *   · enqueue 是注入的（工厂函数）：测试不用真跑模型
 *   · 静态页（app.html）也由这个服务端出 —— 手机只记一个地址
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config.mjs";
import { on } from "../events.mjs";

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "app.html");

function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * @param {{token: string, chatId: string, html?: string, enqueue: (job: object) => void, history?: (limit: number) => Array<{role: string, content: string}>}} deps
 * @returns {{server: import("node:http").Server}}
 */
export function createAppApiServer({ token, chatId, html, enqueue, history }) {
  const clients = new Set(); // 活着的 SSE 响应

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = req.headers.authorization ?? "";
    const tokenOk = safeEqual(auth, `Bearer ${token}`);

    // ── 静态页和图标：不需要 Token（里面没有任何数据）──
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(JSON.stringify({
        name: "Erifane",
        short_name: "Erifane",
        start_url: "/",
        display: "standalone",
        background_color: "#0e1014",
        theme_color: "#0e1014",
        icons: [{
          src:
            "data:image/svg+xml," +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="40" fill="#0e1014"/><circle cx="96" cy="86" r="34" fill="none" stroke="#5b9dff" stroke-width="10"/><circle cx="96" cy="86" r="10" fill="#5b9dff"/><path d="M60 140c10 12 26 18 36 18s26-6 36-18" stroke="#5b9dff" stroke-width="10" fill="none" stroke-linecap="round"/></svg>',
            ),
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any",
        }],
      }));
      return;
    }

    // ── 以下全部要 Token ──
    // /stream 例外：EventSource 发不了 Header，它用 ?t= 自行校验
    const isStream = req.method === "GET" && url.pathname === "/stream";
    if (!isStream && !tokenOk) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { text, messageId } = JSON.parse(body || "{}");
          if (!text?.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "text 不能为空" }));
            return;
          }
          enqueue({
            chatId,
            text: String(text).trim(),
            messageId: messageId || `app-${randomUUID()}`,
            announce: true,
            onError: (e) => push(chatId, "answer", `❌ 出错了：${e.message}`),
          });
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true, chatId }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "请求体不是合法 JSON" }));
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/stream") {
      // EventSource 无法带 Header —— Token 允许走查询参数（配合 HTTPS 使用）
      const qToken = url.searchParams.get("t") ?? "";
      if (!safeEqual(qToken, token)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "未授权" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/history") {
      if (typeof history !== "function") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "history 未接入" }));
        return;
      }
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: history(limit) }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  // ── 大脑/调度事件 → SSE 客户端 ──
  // answer/step/tool_call 按 chatId 过滤（别的渠道的会话不进你的手机）；
  // deliver 是定时推送，收件人就是所有者本人，无条件转交。
  function push(type, payload) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  on("answer", (e) => {
    if (e.chatId === chatId) push("answer", { text: e.text });
  });
  on("step", (e) => {
    if (e.chatId === chatId) push("step", { n: e.n });
  });
  on("tool_call", (e) => {
    if (e.chatId === chatId) {
      push("tool_call", { name: e.name, result: String(e.result ?? "").slice(0, 200) });
    }
  });
  on("deliver", (e) => push("deliver", { text: e.text }));

  return { server };
}

/** 生产入口：从磁盘读 PWA、接上真队列和历史消息；没配 Token 就不开 */
export function startAppApi() {
  const { token, port, host, chatId } = config.appApi;
  if (!token) {
    console.warn("【App 网关】未配置 APP_API_TOKEN —— 不启动");
    return;
  }
  // 延迟导入：避免在不需要网关的场景拉起整条大脑链
  return Promise.all([
    import("../brain/queue.mjs"),
    import("../memory/index.mjs"),
  ]).then(([queue, memory]) => {
    const html = readFileSync(HTML_PATH, "utf8");
    const { server } = createAppApiServer({
      token,
      chatId,
      html,
      enqueue: queue.enqueueAgentJob,
      history: (limit) => memory.loadRecent(chatId, limit),
    });
    server.listen(port, host, () => {
      console.log(`【App 网关】http://${host}:${port} 已启动（chatId=${chatId}，仅 Token 鉴权）`);
    });
    return server;
  });
}
