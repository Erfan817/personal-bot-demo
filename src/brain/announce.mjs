/**
 * 大脑层 · 过程通知的展示策略
 * ═══════════════════════════════════════════════════
 * tool_call 事件是给【人】看的过程通知，不是数据通道：
 *   · 模型拿到的是框架消息里的【完整】工具结果，与这里无关；
 *   · 字幕/网页这类工具一返回就是上万字符，原样进过程日志会把
 *     聊天窗口刷成数据垃圾桶 —— 用户要的是结论，不是原料。
 *
 * 所以过程通知只保留开头 + 长度提示：让人知道「发生了什么、
 * 拿到了多少东西」就够了。
 */

export const ANNOUNCE_RESULT_LIMIT = 300;

export function truncateForAnnounce(text, limit = ANNOUNCE_RESULT_LIMIT) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…【完整结果共 ${s.length} 字符，已交给模型处理，不再逐字推送】`;
}
