/**
 * 工具 · 抓取网页
 * ═══════════════════════════════════════════════════
 * 这一层只负责「发请求」，纯逻辑（HTML → 文本）在 lib/html.mjs。
 * 分开的理由：lib 那层不依赖 typebox，可以离线单测。
 */
import { Type } from "typebox";
import { htmlToText, truncate } from "./lib/html.mjs";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export default {
  name: "web_fetch",
  label: "抓取网页",

  description:
    "抓取一个网页并转成纯文本。当用户给了链接、或者你需要读某个页面的具体内容时使用。" +
    "注意：它只能读静态 HTML，读不了需要 JavaScript 渲染的页面。",

  parameters: Type.Object({
    url: Type.String({ description: "完整网址，必须以 http:// 或 https:// 开头" }),
  }),

  async execute(toolCallId, params) {
    const url = String(params.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("网址必须以 http:// 或 https:// 开头");
    }

    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      throw new Error(`抓取失败：HTTP ${res.status}`);
    }

    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    const raw = await res.text();

    // JSON / 纯文本直接返回
    if (ctype.includes("json") || ctype.startsWith("text/plain")) {
      return out(truncate(raw.trim()));
    }

    const plain = htmlToText(raw);
    if (!plain) throw new Error("页面里没有可读文本");

    return out(truncate(plain));
  },
};

function out(text) {
  return { content: [{ type: "text", text }] };
}