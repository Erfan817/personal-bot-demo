/**
 * 运维 · 备份
 * ═══════════════════════════════════════════════════
 * 由 systemd timer 每天跑一次（erifane-backup.timer，04:00，Persistent=true）。
 * 早期用 crontab，已迁移到 systemd timer —— 原因见 README「运维」。
 *
 * 备份什么：
 *   · data/memory.db  —— 全部对话历史和长期记忆（唯一不可再生的数据）
 *   · .env            —— 密钥和配置
 *
 * 三条纪律（2026-09-25 评审后落实）：
 *   1. 备份目录挪出项目文件夹（默认 ~/erifane-backups）：
 *      env-* 是明文密钥，跟项目放在一起，"整个文件夹拷给别人"
 *      就成了一条泄露路径 —— HANDOFF 点名过。标注泄露路径不等于消除它。
 *   2. 全部文件 0600（umask 077 + 显式 chmod）：不依赖默认权限。
 *   3. 文件名用【本地时间】：以前用 toISOString()（UTC），
 *      04:00 北京时间跑出来叫前一天 20:00 —— 项目在 cron 那节专门
 *      强调过按北京时间算，跨日排障时这种名字全是误导。
 *
 * 为什么不能直接 cp 数据库：
 *   SQLite 在 WAL 模式下，主文件和 -wal 文件是配套的。
 *   运行中直接复制可能拿到"半截"的状态，恢复时可能损坏。
 *   正确做法是用 SQLite 自己的备份 API —— better-sqlite3 的
 *   db.backup() 会先做一致性快照再复制。
 *
 * 恢复：见 scripts/restore.mjs（--verify 可在不停服务的情况下验证任意备份）。
 * 安装见 README「运维」一节。
 */
import { mkdirSync, readdirSync, rmSync, statSync, copyFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { db } from "../src/memory/db.mjs";
import { config } from "../src/config.mjs";

const BACKUP_DIR = config.backup.dir;
const KEEP = Number(process.env.BACKUP_KEEP ?? 7); // 保留最近 7 份

mkdirSync(BACKUP_DIR, { recursive: true });
process.umask(0o077); // 之后新建的文件默认就是 600/700，不依赖默认权限

// 本地时间戳（服务器是北京时间）—— 别再用 UTC 的 toISOString
const p2 = (n) => String(n).padStart(2, "0");
const d = new Date();
const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;

// ── 1. 数据库（用 SQLite 的备份 API，安全） ──
const dbDest = join(BACKUP_DIR, `memory-${stamp}.db`);
await db.backup(dbDest);
chmodSync(dbDest, 0o600);
console.log(`[backup] 数据库 → ${dbDest}`);

// ── 2. .env（含密钥！目录在项目之外 + 0600） ──
const envSrc = join(import.meta.dirname, "..", ".env");
if (existsSync(envSrc)) {
  const envDest = join(BACKUP_DIR, `env-${stamp}`);
  copyFileSync(envSrc, envDest);
  chmodSync(envDest, 0o600);
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

const kept = readdirSync(BACKUP_DIR).filter((f) => f.startsWith("memory-")).length;
console.log(`[backup] 完成，数据库备份保留 ${Math.min(KEEP, kept)} 份 → ${BACKUP_DIR}`);
