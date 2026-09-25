/**
 * 桥接层 —— 入站闸门 + 出站处理
 * ═══════════════════════════════════════════════════
 * 这一层是「消息进大脑之前」和「大脑出去之后」的所有关卡。
 *
 * 顺序有讲究（便宜的检查在前，有副作用的在后）：
 *
 *   1. 准入   纯判断，无副作用      -> 不在白名单，直接丢
 *   2. 幂等   会记录 message_id     -> 重复消息，直接丢
 *   3. 限频   会消耗令牌            -> 太频繁，回复提示
 *
 * 为什么不先查幂等：未授权的消息不该污染去重表。
 * 为什么不先查限频：不该为陌生人的消息消耗你的令牌。
 */
import { isAllowed, isConfigured } from "./access.mjs";
import { checkRate } from "./ratelimit.mjs";
import { alreadySeen } from "./dedupe.mjs";

export { shapeReply } from "./outbound.mjs";
export { isConfigured };

/**
 * 一条消息能不能进大脑？
 * @returns {{ok: true} | {ok: false, reason: string, silent: boolean}}
 *   silent = true  表示「不回复」，直接静默丢弃
 */
export function admit({ senderId, messageId }) {
  // ① 准入
  if (!isAllowed(senderId)) {
    return { ok: false, reason: "不在白名单", silent: true };
  }

  // ② 幂等
  if (alreadySeen(messageId)) {
    return { ok: false, reason: "重复消息", silent: true };
  }

  // ③ 限频
  const r = checkRate(senderId);
  if (!r.ok) {
    return {
      ok: false,
      reason: `太频繁了，请 ${r.retryAfter} 秒后再试`,
      silent: false,
    };
  }

  return { ok: true };
}