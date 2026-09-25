/**
 * 语法检查 —— 对所有 .mjs/js 跑 node --check
 *
 * 为什么需要它：
 *   这个项目里已经踩过两次「肉眼查不出来」的语法级错误：
 *     · 星号+斜杠（*\/）在块注释里提前闭合注释
 *     · 中文引号提前闭合字符串
 *   两个都能用 node --check 一秒抓到。
 *
 * ★ 一个真实的插曲：
 *   写这个脚本的第一版时，我在上面那行注释里【直接写了没有转义的 *\/】，
 *   结果脚本自己语法错误 —— 正是它要检测的那个 bug。
 *   所以我把它改成转义写法，并在这里记一笔：
 *   "知道这个坑"和"不再踩这个坑"是两回事，工具比记忆可靠。
 *
 * 跑法：npm run check
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 跨平台取项目根目录（不要手写字符串处理盘符）
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "data"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".mjs") || name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = walk(ROOT).sort();
let failed = 0;

for (const file of files) {
  const rel = relative(ROOT, file) || file;
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`  ok   ${rel}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${rel}`);
    console.error(String(e.stderr ?? e.message).split("\n").slice(0, 5).join("\n"));
  }
}

console.log(
  failed === 0
    ? `\n✅ 语法检查通过（${files.length} 个文件）`
    : `\n❌ ${failed} / ${files.length} 个文件有语法错误`,
);

process.exit(failed === 0 ? 0 : 1);