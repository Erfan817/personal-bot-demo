/**
 * 记忆层 · 会话历史
 * ═══════════════════════════════════════════════════
 * 存 + 取最近的消息，让对话能接得上。
 */
import { db } from "./db.mjs";

const insertMsg = db.prepare(
  "INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)",
);

// 关键：显式指定 rowid，让 FTS 表和主表的 id 对上
const insertFts = db.prepare(
  "INSERT INTO messages_fts (rowid, content, chat_id) VALUES (?, ?, ?)",
);

/**
 * 存一条消息（同时写进全文索引表）
 * 用事务包住，保证两张表一致。
 */
export const saveMessage = db.transaction((chatId, role, content) => {
  const text = String(content ?? "");
  const info = insertMsg.run(chatId, role, text, Date.now());
  insertFts.run(info.lastInsertRowid, text, chatId);
});

/**
 * 取某个会话最近 N 条消息（按时间正序返回，方便直接喂给模型）
 */
export function loadRecent(chatId, limit) {
  const rows = db
    .prepare(
      `SELECT role, content, created_at
         FROM messages
        WHERE chat_id = ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(chatId, limit);

  return rows.reverse();
}

/** 清空某个会话的历史（调试用） */
export function clearChat(chatId) {
  const ids = db
    .prepare("SELECT id FROM messages WHERE chat_id = ?")
    .all(chatId)
    .map((r) => r.id);

  const delMsg = db.prepare("DELETE FROM messages WHERE id = ?");
  const delFts = db.prepare("DELETE FROM messages_fts WHERE rowid = ?");

  return db.transaction(() => {
    for (const id of ids) {
      delFts.run(id);
      delMsg.run(id);
    }
    return ids.length;
  })();
}

/** 总消息数（自检用） */
export function countAll() {
  return db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
}