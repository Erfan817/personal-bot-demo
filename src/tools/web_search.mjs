/**
 * 工具 · 网上搜索
 * ═══════════════════════════════════════════════════
 * 双通道设计：
 *
 *   配了 BRAVE_API_KEY  ->  用 Brave Search API（稳定、有配额）
 *   没配                ->  抓 DuckDuckGo 的 HTML 接口（免费、无需 key）
 *
 * ⚠️ 为什么必须显式识别"人机验证页"：
 *   DuckDuckGo 对 VPS / 代理 / Tor 的 IP 会返回验证页，
 *   而且页面里【没有结果】—— 如果不识别，就会误报成
 *   「没有搜到结果」，让人以为是搜索词的问题。
 *   这是"静默失败"的又一个典型例子。
 */
import { Type } from "typebox";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export default {
  name: "web_search",
  label: "网上搜索",

  description:
    "在互联网上搜索。当用户说「查一下」「搜一下」「最新」「现在是什么情况」，" +
    "或者你需要自己不确定的事实时，必须用这个工具，不要凭记忆回答。" +
    "搜到结果后，如果需要细节，再用 web_fetch 打开具体页面。",

  parameters: Type.Object({
    query: Type.String({ description: "搜索关键词" }),
    limit: Type.Optional(Type.Number({ description: "返回条数，默认 5，最多 10" })),
  }),

  async execute(toolCallId, params) {
    const query = String(params.query ?? "").trim();
    if (!query) throw new Error("搜索词不能为空");

    const limit = Math.max(1, Math.min(Number(params.limit ?? 5), 10));

    const braveKey = process.env.BRAVE_API_KEY;
    if (braveKey) return out(await brave(query, limit, braveKey));
    return out(await duckduckgo(query, limit));
  },
};

function out(text) {
  return { content: [{ type: "text", text }] };
}

/* ══════════════════ DuckDuckGo（免费，无需 key） ══════════════════ */

async function duckduckgo(query, limit) {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: AbortSignal.timeout(20000),
    },
  );

  if (!res.ok) throw new Error(`搜索失败：HTTP ${res.status}`);

  const html = await res.text();

  // ★ 关键：先判断是不是验证页，别当成"没结果"
  if (
    html.includes("anomaly-modal") ||
    html.includes("Unfortunately, bots use DuckDuckGo too") ||
    html.includes("detected unusual traffic")
  ) {
    throw new Error(
      "DuckDuckGo 返回了人机验证页（服务器 IP 被标记为数据中心）。" +
        "这不是「没搜到」，而是通道被拦了 —— 建议配置 BRAVE_API_KEY 换用 API。",
    );
  }

  const items = parseDdg(html, limit);
  if (items.length === 0) throw new Error(`没有搜到结果：${query}`);

  return format(items);
}

function parseDdg(html, limit) {
  const items = [];

  // 标题 + 链接
  const linkRe =
    /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) && items.length < limit) {
    items.push({
      url: unwrapDdg(m[1]),
      title: stripTags(m[2]),
      snippet: "",
    });
  }

  // 摘要（按出现顺序对应）
  const snippets = [
    ...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi),
  ].map((s) => stripTags(s[1]));

  items.forEach((it, i) => {
    it.snippet = snippets[i] ?? "";
  });

  return items;
}

/** DuckDuckGo 会把真实网址包在 /l/?uddg=... 里，要拆出来 */
function unwrapDdg(href) {
  try {
    const u = new URL(href.startsWith("//") ? "https:" + href : href, "https://duckduckgo.com");
    const real = u.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}

/* ══════════════════ Brave（需要 key，稳定） ══════════════════ */

async function brave(query, limit, key) {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": key,
      },
      signal: AbortSignal.timeout(20000),
    },
  );

  if (!res.ok) {
    throw new Error(`Brave 搜索失败：HTTP ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const items = (data?.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));

  if (items.length === 0) throw new Error(`没有搜到结果：${query}`);
  return format(items);
}

/* ══════════════════ 共用 ══════════════════ */

function format(items) {
  return items
    .map((it, i) => {
      const lines = [`${i + 1}. ${it.title}`, `   ${it.url}`];
      if (it.snippet) lines.push(`   ${it.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}