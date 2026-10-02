/**
 * 记忆层 · 记忆卡（结构化长期记忆）
 * ═══════════════════════════════════════════════════
 * messages 是【档案】：对话原文，只增不减，检索是纯字面的；
 * memories 是【卡片】：模型提炼后的意思 + 检索关键词 + 主题，
 * 可增、可改、可归档 —— "长期记忆"真正的载体。
 *
 * topic 就是「卡名」（健身 / 学习 / 饮食 / 工作…）：
 *   · 写入时由模型按主题归卡，同一主题的进展更新同一张卡（去重见下）
 *   · 每轮注入 system prompt 的「核心记忆」按 重要度 × 新近度 取 top N
 *   · 定期整理（合并 / 降权 / 归档）由调度任务驱动
 *
 * keywords 是检索增益：存卡时把同义词一并写进关键词列
 * （「橘猫」的卡顺手写上「宠物 猫」），字面 FTS 就能跨同义召回 ——
 * 这是 messages 档案层做不到的事（那里只有原话）。
 *
 * ⚠️ 继承 db.mjs 里那条纪律：FTS 表的 rowid 显式 = memories.id，
 *    删改时同步删索引行（普通 FTS5 表按 rowid DELETE 即可），
 *    永远不留幽灵索引。
 */
import { db } from "./db.mjs";

const CONTENT_MAX = 500; // 记忆卡不是日记 —— 一张卡说清一件事
const TOPIC_MAX = 24;

const clampImportance = (n) =>
  Math.min(5, Math.max(1, Math.round(Number(n) || 3)));

function syncFtsAdd(id, content, keywords) {
  db.prepare(
    "INSERT INTO memories_fts(rowid, content, keywords) VALUES (?, ?, ?)",
  ).run(id, content, keywords);
}

function syncFtsRemove(id) {
  // 普通内容存储型 FTS5 表：直接按 rowid DELETE 就行。
  // ⚠️ 不走 `INSERT ... VALUES('delete', ...)` 那种命令形式 ——
  // 它只用于 contentless / external-content 表，普通表上直接报
  // SQLITE_ERROR（实测踩过）。messages 层的 clearChat 也是这么删的。
  db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(id);
}

/** 活跃卡里找同内容卡：先精确匹配，再 FTS 短语匹配（内容 ≥3 字时） */
function findActiveDuplicate(content) {
  const exact = db
    .prepare(
      "SELECT id, content, keywords FROM memories WHERE status = 'active' AND content = ? ORDER BY id DESC LIMIT 1",
    )
    .get(content);
  if (exact) return exact;

  if (content.length < 3) return null; // trigram 的 3 字下限
  const phrase = `"${content.replace(/"/g, '""')}"`;
  return (
    db
      .prepare(
        `SELECT m.id, m.content, m.keywords
           FROM memories m
          WHERE m.status = 'active'
            AND m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)
          ORDER BY m.id DESC LIMIT 1`,
      )
      .get(phrase) ?? null
  );
}

/**
 * 写一张卡。同内容的活跃卡已存在时改为【更新】——
 * 模型重复表达同一件事（"我再记一下…"）不会刷出一堆重复卡。
 * @returns {{id: number, updated: boolean}}
 */
export function addMemory({
  chatId = "cli",
  topic = "日常",
  content,
  keywords = "",
  importance = 3,
  sourceMsgId = null,
}) {
  content = String(content ?? "").trim().slice(0, CONTENT_MAX);
  if (!content) throw new Error("记忆内容不能为空");
  topic = String(topic ?? "").trim().slice(0, TOPIC_MAX) || "日常";

  // 主题本身就是最好的检索词 —— 一定进关键词列
  const kw = [
    ...new Set([topic, ...String(keywords ?? "").trim().split(/\s+/).filter(Boolean)]),
  ].join(" ");
  const now = Date.now();
  const imp = clampImportance(importance);

  const dup = findActiveDuplicate(content);
  if (dup) {
    db.prepare(
      `UPDATE memories
          SET content = ?, topic = ?, keywords = ?, importance = ?,
              updated_at = ?, source_msg_id = COALESCE(?, source_msg_id)
        WHERE id = ?`,
    ).run(content, topic, kw, imp, now, sourceMsgId, dup.id);
    syncFtsRemove(dup.id);
    syncFtsAdd(dup.id, content, kw);
    return { id: dup.id, updated: true };
  }

  const r = db
    .prepare(
      `INSERT INTO memories
         (chat_id, topic, content, keywords, importance, status, source_msg_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(chatId, topic, content, kw, imp, sourceMsgId, now, now);
  syncFtsAdd(r.lastInsertRowid, content, kw);
  return { id: r.lastInsertRowid, updated: false };
}

/**
 * 检索记忆卡。命中会刷新 last_used_at（定期整理的"衰减"依据）。
 * <3 字查询降级 LIKE（trigram 下限，同 messages 层）。
 */
export function searchMemories(query, { topic = null, limit = 5 } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const topicCond = topic ? "AND m.topic = ?" : "";
  const topicArgs = topic ? [topic] : [];

  let rows;
  if (q.length < 3) {
    rows = db
      .prepare(
        `SELECT m.* FROM memories m
          WHERE m.status = 'active' ${topicCond}
            AND (m.content LIKE ? OR m.keywords LIKE ? OR m.topic LIKE ?)
          ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`,
      )
      .all(...topicArgs, `%${q}%`, `%${q}%`, `%${q}%`, limit);
  } else {
    const phrase = `"${q.replace(/"/g, '""')}"`;
    rows = db
      .prepare(
        `SELECT m.* FROM memories m
          WHERE m.status = 'active' ${topicCond}
            AND m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)
          ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`,
      )
      .all(...topicArgs, phrase, limit);
  }

  if (rows.length) {
    db.prepare(
      `UPDATE memories SET last_used_at = ? WHERE id IN (${rows.map(() => "?").join(",")})`,
    ).run(Date.now(), ...rows.map((r) => r.id));
  }
  return rows;
}

/** 列卡：按主题分组排序，看板用 */
export function listMemories({ topic = null, status = "active", limit = 100 } = {}) {
  const topicCond = topic ? "AND topic = ?" : "";
  const topicArgs = topic ? [topic] : [];
  return db
    .prepare(
      `SELECT * FROM memories WHERE status = ? ${topicCond}
        ORDER BY topic, importance DESC, updated_at DESC LIMIT ?`,
    )
    .all(status, ...topicArgs, limit);
}

/** 各主题的卡数概览 */
export function topicsSummary() {
  return db
    .prepare(
      `SELECT topic, COUNT(*) AS n, MAX(updated_at) AS latest
         FROM memories WHERE status = 'active'
        GROUP BY topic ORDER BY n DESC, latest DESC`,
    )
    .all();
}

/** 每轮注入 system prompt 的「核心记忆」：重要度优先，其次新近 */
export function coreMemories(limit = 10) {
  return db
    .prepare(
      `SELECT topic, content, importance FROM memories
        WHERE status = 'active'
        ORDER BY importance DESC, updated_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function getMemory(id) {
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(Number(id)) ?? null;
}

/** 归档：不参与检索和注入，但留着 —— 记忆的"冷存储" */
export function archiveMemory(id) {
  const r = db
    .prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?")
    .run(Date.now(), Number(id));
  return r.changes > 0;
}

export function removeMemory(id) {
  const row = getMemory(id);
  if (!row) return false;
  syncFtsRemove(row.id);
  db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
  return true;
}

export function countMemories(status = "active") {
  return db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = ?").get(status).n;
}
