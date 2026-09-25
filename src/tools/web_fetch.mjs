/**
 * 工具 · 抓取网页
 * ═══════════════════════════════════════════════════
 * 把网页转成纯文本喂给模型。
 *
 * 为什么不用 cheerio / jsdom 之类的库：
 *   我们要的是"能读懂"，不是"精确解析"。
 *   正则剥离标签对这个场景够用，而且零依赖、启动快。
 *   如果以后要精确定位页面元素，再换正经的解析器。
 */
import { Type } from "typebox";

const MAX_CHARS = 8000; // 太长会撑爆上下文，截断更划算
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

function truncate(s) {
  if (s.length <= MAX_CHARS) return s;
  return s.slice(0, MAX_CHARS) + `\n\n…（内容过长，已截断，原始长度 ${s.length} 字）`;
}

/** 极简 HTML → 纯文本 */
function htmlToText(html) {
  return html
    // 先干掉整块不需要的内容
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // 块级标签的结束处补换行，保住段落结构
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // 剩下所有标签都去掉
    .replace(/<[^>]+>/g, " ")
    // 常见实体
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    // 收尾清理
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}