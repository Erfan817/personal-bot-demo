/**
 * 协议层 · 命令行渠道
 * ═══════════════════════════════════════════════════
 * 它只做两件事：
 *   1. 把用户输入交给大脑
 *   2. 订阅大脑的事件，负责「展示」
 *
 * 将来飞书渠道做的是同样两件事 —— 这就是分层的意义。
 * 换渠道，大脑一行都不用改。
 */
import { runAgent } from "../brain/loop.mjs";
import { on } from "../events.mjs";

export function startCli() {
  // ── 订阅大脑的事件（这一步就是「渠道」的全部工作）──
  on("step", (n) => console.log(`\n── 第 ${n} 轮 ──`));

  on("tool_call", ({ name, args, result }) => {
    console.log(`🔧 ${name}(${JSON.stringify(args)})`);
    console.log(`   ↳ ${result}`);
  });

  on("answer", (text) => console.log(`\n🤖 ${text}`));

  // 调度层的定时推送（cli 模式跑完就退出，这里一般不会触发；
  // 留着是为了让"渠道层订阅 deliver"这件事在两种渠道里保持一致）
  on("deliver", ({ text }) => console.log(`\n📅 ${text}`));

  // ── 把输入交给大脑 ──
  const input = process.argv.slice(2).join(" ") || "帮我算一下 123 * 456";
  console.log(`👤 ${input}`);

  return runAgent(input);
}