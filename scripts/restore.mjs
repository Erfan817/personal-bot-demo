/**
 * 运维 · 恢复
 * ═══════════════════════════════════════════════════
 * 备份唯一的验收标准是「能不能用它把记忆库恢复出来」——
 * 所以恢复脚本和备份脚本一起落地，并且 --verify 模式可以在
 * 【不停服务】的情况下验证任意一份备份：完整性 + 行数对读。
 *
 *   node scripts/restore.mjs --verify  <backup.db>    只验证，不动任何东西
 *   node scripts/restore.mjs --restore <backup.db>    真恢复（要求服务已停止）
 *
 * 真恢复的完整流程（服务在跑时脚本会拒绝执行）：
 *   1. sudo systemctl stop erifane-bot
 *   2. node scripts/restore.mjs --restore <backup.db>
 *   3. sudo systemctl start erifane-bot
 *   4. 走一遍 HANDOFF §5 验证链条（消息数应与 --verify 报告的一致）
 */
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, rmSync, statSync, chmodSync } from "node:fs";
import Database from "better-sqlite3";
import { config } from "../src/config.mjs";

const DB_PATH = config.memory.dbPath;
const [mode, file] = process.argv.slice(2);

if ((mode !== "--verify" && mode !== "--restore") || !file) {
  console.error(
    "用法：node scripts/restore.mjs --verify <backup.db>\n" +
      "      node scripts/restore.mjs --restore <backup.db>",
  );
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`❌ 备份文件不存在: ${file}`);
  process.exit(1);
}

/* ══════════════════ --verify：只读验证 ══════════════════ */
if (mode === "--verify") {
  const stat = statSync(file);
  if (stat.size === 0) {
    console.error("❌ 备份文件是空的");
    process.exit(1);
  }

  const db = new Database(file, { readonly: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  const nMsg = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  const nFts = db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get().n;
  db.close();

  console.log(`文件        : ${file}（${(stat.size / 1024).toFixed(1)} KB）`);
  console.log(`integrity   : ${integrity}`);
  console.log(`messages    : ${nMsg} 条`);
  console.log(`messages_fts: ${nFts} 条（应与 messages 一致 —— rowid 显式对齐）`);

  const ok =
    String(integrity).toLowerCase().startsWith("ok") && nMsg === nFts;
  console.log(
    ok ? "✅ 这份备份可以用来恢复" : "❌ 备份有问题，不要用它恢复",
  );
  process.exit(ok ? 0 : 1);
}

/* ══════════════════ --restore：真恢复 ══════════════════ */

let active = "unknown";
try {
  active = execFileSync("systemctl", ["is-active", "erifane-bot"], {
    stdio: "pipe",
  })
    .toString()
    .trim();
} catch {
  // 单元不存在 / systemctl 不可用 —— 按"不在运行"处理
}
if (active === "active") {
  console.error("❌ 服务正在运行，运行中覆盖数据库文件会被 WAL 破坏。先执行：");
  console.error("   sudo systemctl stop erifane-bot");
  process.exit(1);
}

for (const suffix of ["-wal", "-shm"]) {
  const f = DB_PATH + suffix;
  if (existsSync(f)) {
    rmSync(f);
    console.log(`已删除 ${f}（旧 WAL，与新恢复的库不配套）`);
  }
}
copyFileSync(file, DB_PATH);
chmodSync(DB_PATH, 0o600);
console.log(`✅ 已用 ${file} 覆盖 ${DB_PATH}`);
console.log("下一步：sudo systemctl start erifane-bot，然后走 HANDOFF §5 验证链条。");
