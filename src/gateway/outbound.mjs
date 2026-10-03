/**
 * 桥接层 · 出站处理
 * ═══════════════════════════════════════════════════
 * 大脑产出的文本，不能原样丢给飞书：
 *
 *   1. 长度：单条消息有上限，太长要切开
 *   2. 切得聪明：尽量在换行处切，别把句子劈成两半
 *
 * （以后还可以在这里加：敏感内容过滤、Markdown 转飞书卡片等）
 */
const MAX_LEN = 4000; // 单条消息的安全长度，留足余量

/**
 * Markdown → 纯文本
 * ═══════════════════════════════════════════════════
 * 模型天生输出 Markdown（**加粗**、## 标题、表格），而飞书/终端
 * 的纯文本消息不渲染这些符号 —— 星号全部裸露给用户。
 * 提示词里约束模型是软手段（经常守不住），这里是硬兜底。
 *
 * 只处理纯文本消息里最碍眼、且规则可靠的几类：
 *   代码围栏、标题、加粗、行内代码、链接、星号列表、引用、分隔线。
 *   刻意【不】处理单星号斜体 —— 会误伤 "3 * 4" 这类乘法表达。
 * 表格也保留原样（竖线行可读性尚可，转换规则不可靠）。
 */
export function toPlainText(text) {
  let s = String(text ?? "");
  s = s.replace(/```[a-zA-Z]*\n?/g, ""); // 代码围栏标记
  s = s.replace(/^#{1,6}\s+/gm, ""); // 标题
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1"); // 加粗
  s = s.replace(/`([^`]+)`/g, "$1"); // 行内代码
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1（$2）"); // 链接
  s = s.replace(/^(\s*)[*•]\s+/gm, "$1· "); // 星号列表 → 间隔点
  s = s.replace(/^>\s?/gm, ""); // 引用
  s = s.replace(/^(-{3,}|_{3,})\s*$/gm, ""); // 分隔线
  s = s.replace(/\n{3,}/g, "\n\n"); // 压缩多余空行
  return s.trim();
}

/**
 * 把回复切成若干条消息
 * @param {string} text
 * @returns {string[]}
 */
export function shapeReply(text) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  if (s.length <= MAX_LEN) return [s];

  const chunks = [];
  let rest = s;

  while (rest.length > MAX_LEN) {
    // 优先在换行处切
    let cut = rest.lastIndexOf("\n", MAX_LEN);
    // 没有合适的换行点（或者太靠前），就硬切
    if (cut < MAX_LEN * 0.5) cut = MAX_LEN;

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest) chunks.push(rest);

  // 多于一条时，加上序号提示
  if (chunks.length > 1) {
    return chunks.map((c, i) => `（${i + 1}/${chunks.length}）\n${c}`);
  }
  return chunks;
}