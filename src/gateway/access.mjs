/**
 * 桥接层 · 准入
 * ═══════════════════════════════════════════════════
 * 谁能让 bot 干活？
 *
 * 这是所有防御里最外面、也最重要的一道：
 * 你的 bot 挂在飞书上，任何能给它发消息的人都能触发它。
 * 而它有工具（能算、以后能搜网、能读文件）——
 * 不设白名单，它就变成"别人的工具"。
 */
import { config } from "../config.mjs";

/**
 * @param {string} senderId 飞书的 open_id
 * @returns {boolean}
 */
export function isAllowed(senderId) {
  const list = config.gateway.allowedUsers;

  // 白名单为空 = 拒绝所有人（安全默认）
  // 这样你第一次跑的时候，能在日志里看到自己的 open_id，再填进 .env
  if (list.length === 0) return false;

  // 支持 "*" 显式放开（危险，仅调试用）
  if (list.includes("*")) return true;

  return list.includes(senderId);
}

/** 白名单是否已配置（用来给出更友好的日志） */
export function isConfigured() {
  return config.gateway.allowedUsers.length > 0;
}