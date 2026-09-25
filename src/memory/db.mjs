/**
 * 记忆层 · 数据库
 * ═══════════════════════════════════════════════════
 * 用 SQLite：单文件、零运维、够快、够可靠。
 * 进程内嵌入，没有"数据库服务"要维护 —— 对个人 bot 是完美选择。
 *
 * ⚠️ 中文全文检索的坑（很重要）：
 *   FTS5 默认的 unicode61 分词器按"非字母数字"切词。
 *   中文没有空格 → 整句话会变成一个 token → 检索基本失效。
 *
 *   解法：用 trigram 分词器（按 3 字符滑窗建索引），
 *        对中文子串检索效果很好。
 *   代价：查询串必须 ≥ 3 个字符才走 FTS，短查询退化成 LIKE。
 *
 * ⚠️ 另一个容易搞错的点：
 *   FTS 表和主表是两个独立表，它们各自的 rowid 默认毫无关系。
 *   我们【显式指定】FTS 的 rowid = 消息 id，这样两边就能对上，
 *   删改也能同步。
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.mjs";

mkdirSync(dirname(config.memory.dbPath), { recursive: true });

export const db = new Database(config.memory.dbPath);

// WAL 模式：读写不互相阻塞，崩了也不容易坏
db.pragma("journal_mode = WAL");

db.exec(`
  -- 所有消息：既当会话历史，也当长期档案
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT    NOT NULL,
    role       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat
    ON messages(chat_id, id);

  -- 全文检索表（trigram 分词，为中文优化）
  -- 注意：插入时会显式指定 rowid = messages.id
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content, chat_id UNINDEXED, tokenize='trigram');
`);