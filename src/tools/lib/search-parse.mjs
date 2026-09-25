/**
 * 纯函数：搜索结果解析
 * ═══════════════════════════════════════════════════
 * 全是纯函数（字符串 -> 结构化数据），不碰网络、不依赖第三方包。
 * web_search.mjs 那层只负责"发请求 + 决定用哪条通道"。
 *
 * 这样拆的收益：这层逻辑可以离线单测，不用真的联网。
 */

/** 去掉标签 + 解码常见实体 */
export function stripTags(s) {
  return String(s ?? "")
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

/**
 * DuckDuckGo 是否返回了「人机验证页」
 * ═══════════════════════════════════════════════════
 * ★ 这是「区分没有数据 / 拿不到数据」的关键判断。
 *
 *   验证页里【什么结果都没有】，如果不识别，就会被当成
 *   「没有搜到结果」——给用户的建议完全不同：
 *     "换个词搜搜"      vs      "搜索通道被拦了，换 API"
 *
 *   这是"静默失败"的典型，必须有测试兜着。
 */
export function isDdgBlocked(html) {
  const h = String(html ?? "");
  return (
    h.includes("anomaly-modal") ||
    h.includes("Unfortunately, bots use DuckDuckGo too") ||
    h.includes("detected unusual traffic")
  );
}

/** DuckDuckGo 会把真实网址包在 /l/?uddg=... 里，要拆出来 */
export function unwrapDdg(href) {
  const raw = String(href ?? "");
  if (!raw) return raw;
  try {
    const u = new URL(
      raw.startsWith("//") ? `https:${raw}` : raw,
      "https://duckduckgo.com",
    );
    const real = u.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : raw;
  } catch {
    return raw; // 解析不了就原样返回，不能炸
  }
}

/** 从 DuckDuckGo 的结果页里抠出条目 */
export function parseDdg(html, limit = 5) {
  const items = [];

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

  // 摘要按出现顺序对应
  const snippets = [
    ...String(html).matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi),
  ].map((s) => stripTags(s[1]));

  items.forEach((it, i) => {
    it.snippet = snippets[i] ?? "";
  });

  return items;
}

/** 把结果列表格式化成给模型看的文本 */
export function formatResults(items) {
  return items
    .map((it, i) => {
      const lines = [`${i + 1}. ${it.title}`, `   ${it.url}`];
      if (it.snippet) lines.push(`   ${it.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
}