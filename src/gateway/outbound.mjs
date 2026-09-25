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