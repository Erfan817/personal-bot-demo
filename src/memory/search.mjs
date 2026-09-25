/**
 * 记忆层 · 长期检索
 * ═══════════════════════════════════════════════════
 * 让 agent 能"翻旧账"：在全部历史里找相关内容。
 * 这对应你朋友那套里的 history_search 工具。
 */
import { db } from "./db.mjs";

/**
 * 在历史消息里检索
 * @param {string} query 关键词
 * @param {number} limit 返回条数
 */
export function searchHistory(query, limit = 5) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  // trigram 分词器要求查询 ≥ 3 个字符，否则退化成 LIKE
  if (q.length < 3) {
    return db
      .prepare(
        `SELECT role, content, created_at
           FROM messages
          WHERE content LIKE ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(`%${q}%`, limit);
  }

  // FTS5 查询串要转义：把 " 变成 ""，再整体包成短语
  const phrase = `"${q.replace(/"/g, '""')}"`;

  return db
    .prepare(
      `SELECT role, content, created_at
         FROM messages
        WHERE id IN (
          SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
        )
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(phrase, limit);
}