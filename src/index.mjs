/**
 * 入口 —— 把各层组装起来
 * ═══════════════════════════════════════════════════
 * 这是唯一知道「用哪个渠道」的地方。
 *
 *   CHANNEL=cli     node src/index.mjs "帮我算一下 123 * 456"
 *   CHANNEL=feishu  node src/index.mjs          （长驻：收消息 + 定时任务）
 *
 * 调度层只在 feishu（长驻）模式下启动 ——
 * cli 模式跑完就退出，定时器没有意义。
 */
import { config } from "./config.mjs";
import { toolNames } from "./tools/index.mjs";

if (!config.model.apiKey) {
  console.error("❌ 没配置 DEEPSEEK_API_KEY —— 在 ~/erifane-bot/.env 里填一个");
  process.exit(1);
}

console.log(`【模型】${config.model.provider} / ${config.model.name}`);
console.log(`【白名单】${toolNames().join(", ")}`);
console.log(`【渠道】${config.channel}`);
console.log(`【时区】${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

if (config.channel === "feishu") {
  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.error("❌ 没配置 FEISHU_APP_ID / FEISHU_APP_SECRET —— 在 .env 里填上");
    process.exit(1);
  }

  const { startFeishu } = await import("./channels/feishu.mjs");
  startFeishu().catch((e) => {
    console.error(`\n❌ 飞书渠道启动失败：${e.message}`);
    process.exit(1);
  });

  // 心跳：给外部健康检查用（判定"进程还活着但卡死了"）
  const { startHeartbeat } = await import("./heartbeat.mjs");
  startHeartbeat();

  // 长驻模式下才需要调度层
  const { startScheduler } = await import("./scheduler/index.mjs");
  startScheduler();
} else {
  const { startCli } = await import("./channels/cli.mjs");
  startCli().catch((e) => {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  });
}