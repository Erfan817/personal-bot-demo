/**
 * 工具 · 网上搜索
 * ═══════════════════════════════════════════════════
 * 双通道：
 *   配了 BRAVE_API_KEY  ->  Brave Search API（稳定、有配额）
 *   没配                ->  抓 DuckDuckGo HTML（免费、无需 key）
 *
 * 这一层只负责「发请求 + 选通道」，
 * 解析和验证页识别在 lib/search-parse.mjs（那样才能离线单测）。
 */
import { Type } from "typebox";
import { isDdgBlocked, parseDdg, formatResults } from "./lib/search-parse.mjs";
import { wrapExternal } from "./lib/boundary.mjs";

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
    const text = braveKey
      ? await searchBrave(query, limit, braveKey)
      : await searchDuckDuckGo(query, limit);

    // 数据边界：搜索结果只是资料，包上标记再进上下文
    return { content: [{ type: "text", text: wrapExternal(text, "网页搜索") }] };
  },
};

/* ══════════════════ DuckDuckGo（免费，无需 key） ══════════════════ */

async function searchDuckDuckGo(query, limit) {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: AbortSignal.timeout(20000),
    },
  );

  if (!res.ok) throw new Error(`搜索失败：HTTP ${res.status}`);

  const html = await res.text();

  // ★ 先判断是不是验证页，别当成"没结果"
  if (isDdgBlocked(html)) {
    throw new Error(
      "DuckDuckGo 返回了人机验证页（服务器 IP 被标记为数据中心）。" +
        "这不是「没搜到」，而是通道被拦了 —— 建议配置 BRAVE_API_KEY 换用 API。",
    );
  }

  const items = parseDdg(html, limit);
  if (items.length === 0) throw new Error(`没有搜到结果：${query}`);

  return formatResults(items);
}

/* ══════════════════ Brave（需要 key，稳定） ══════════════════ */

async function searchBrave(query, limit, key) {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
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
  return formatResults(items);
}