/**
 * 桥接层 · 幂等去重
 * ═══════════════════════════════════════════════════
 * 为什么必须做（不是设计洁癖，是被平台逼的）：
 *
 *   飞书要求事件回调 3 秒内返回，否则【超时重推】。
 *   我们的 agent 跑一轮要好几秒 → 必须异步 → 异步就会遇到重推
 *   → 同一条消息会来两次 → bot 会重复回答两遍。
 *
 * 所以：按 message_id 记住"处理过的"，重复的直接丢掉。
 */
const seen = new Map(); // message_id -> 时间戳
const TTL = 5 * 60 * 1000; // 5 分钟内算重复
const MAX_ENTRIES = 2000; // 上限，防止内存无限涨

/**
 * @param {string} messageId
 * @returns {boolean} true = 之前见过（应丢弃）
 */
export function alreadySeen(messageId) {
  if (!messageId) return false;

  const now = Date.now();

  // 顺手清理过期项
  for (const [k, t] of seen) {
    if (now - t > TTL) seen.delete(k);
  }

  if (seen.has(messageId)) return true;

  seen.set(messageId, now);

  // 兜底：万一短时间内涌入巨量消息
  if (seen.size > MAX_ENTRIES) {
    const oldest = seen.keys().next().value;
    seen.delete(oldest);
  }

  return false;
}

/** 当前记录数（调试用） */
export function dedupeSize() {
  return seen.size;
}