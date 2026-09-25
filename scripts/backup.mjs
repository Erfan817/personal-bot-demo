/**
 * 运维 · 备份
 * ═══════════════════════════════════════════════════
 * 由 systemd timer 每天跑一次（erifane-backup.timer，04:00，Persistent=true）。
 * 早期用 crontab，已迁移到 systemd timer —— 原因见 README「运维」。
 *
 * 备份什么：
 *   · data/memory.db  —— 全部对话历史和长期记忆
 *   · .env            —— 密钥和配置（注意别外传）
 *
 * 为什么不能直接 cp 数据库：
 *   SQLite 在 WAL 模式下，主文件和 -wal 文件是配套的。
 *   运行中直接复制可能拿到"半截"的状态，恢复时可能损坏。
 *   正确做法是用 SQLite 自己的备份 API —— better-sqlite3 提供了
 *   db.backup()，它会先做一致性快照再复制。
 *
 * 安装见 README「运维」一节：
 *   sudo cp scripts/erifane-backup.service scripts/erifane-backup.timer /etc/systemd/system/
 *   sudo systemctl enable --now erifane-backup.timer
 */
import { mkdirSync, readdirSync, rmSync, statSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { db } from "../src/memory/db.mjs";
import { config } from "../src/config.mjs";

const BACKUP_DIR = join(dirname(config.memory.dbPath), "backups");
const KEEP = Number(process.env.BACKUP_KEEP ?? 7); // 保留最近 7 份

mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .slice(0, 19);

// ── 1. 数据库（用 SQLite 的备份 API，安全） ──
const dbDest = join(BACKUP_DIR, `memory-${stamp}.db`);
await db.backup(dbDest);
console.log(`[backup] 数据库 → ${dbDest}`);

// ── 2. .env（含密钥！备份目录已在 .gitignore 里） ──
const envSrc = join(import.meta.dirname, "..", ".env");
if (existsSync(envSrc)) {
  const envDest = join(BACKUP_DIR, `env-${stamp}`);
  copyFileSync(envSrc, envDest);
  console.log(`[backup] 配置 → ${envDest}`);
}

// ── 3. 清理旧备份 ──
const old = readdirSync(BACKUP_DIR)
  .filter((f) => f.startsWith("memory-"))
  .map((f) => ({ f, t: statSync(join(BACKUP_DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(KEEP);

for (const { f } of old) {
  rmSync(join(BACKUP_DIR, f));
  // 对应的 env 快照也一起删
  const envPair = f.replace("memory-", "env-").replace(/\.db$/, "");
  for (const g of readdirSync(BACKUP_DIR)) {
    if (g.startsWith(envPair)) rmSync(join(BACKUP_DIR, g));
  }
  console.log(`[backup] 清理旧备份 ${f}`);
}

console.log(`[backup] 完成，数据库备份保留 ${Math.min(KEEP, readdirSync(BACKUP_DIR).filter((f) => f.startsWith("memory-")).length)} 份`);