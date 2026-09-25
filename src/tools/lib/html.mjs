/**
 * 纯函数：HTML → 纯文本
 * ═══════════════════════════════════════════════════
 * 为什么单独一个文件：
 *   这里全是纯函数（输入字符串 -> 输出字符串），
 *   而 web_fetch.mjs 那层需要 typebox 来定义参数 schema。
 *   分开之后，这层逻辑【不依赖任何第三方包】就能单测。
 *
 * 为什么不用 cheerio / jsdom：
 *   我们要的是"能读懂"，不是"精确解析"。
 *   正则剥离对这个场景够用，而且零依赖、启动快。
 *   要精确定位页面元素时，再换正经解析器。
 */

export const MAX_CHARS = 8000; // 太长会撑爆上下文，截断更划算

/** 极简 HTML → 纯文本 */
export function htmlToText(html) {
  return String(html ?? "")
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

/** 超长就截断，并明确告诉调用方"被截断了" */
export function truncate(s, max = MAX_CHARS) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n\n…（内容过长，已截断，原始长度 ${str.length} 字）`;
}