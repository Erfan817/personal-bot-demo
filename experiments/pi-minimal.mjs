/**
 * 第 4 步 · 实验 A：先确认框架能跑
 * ═══════════════════════════════════════════════════════════
 * 这个文件【不接入】我们的项目结构。
 * 它只回答一个问题：框架 + 我们的模型 + API key，这条链通不通？
 *
 * 跑法：  node experiments/pi-minimal.mjs
 *
 * 对应 pi-ai / pi-agent-core 版本：0.87.1
 * ═══════════════════════════════════════════════════════════
 */
import "../src/config.mjs"; // 触发 .env 加载 —— 让 provider 能读到 DEEPSEEK_API_KEY

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Agent } from "@earendil-works/pi-agent-core";

// ── 1. 建一个 Models 集合（一次注册所有内置 provider）──────
console.log("=== 1. 已注册的 provider ===");
const models = builtinModels();
const providers = models.getProviders();
console.log("  " + providers.map((p) => p.id ?? p.name ?? "?").join(", "));

// ── 2. 取出 DeepSeek 模型 ────────────────────────────────
console.log("\n=== 2. 取模型 ===");

// pi-ai 目录里的 id 和 DeepSeek 官方 API 的 id 不一定一致，所以用候选名单自动试
const CANDIDATES = (process.env.PI_MODEL ?? "deepseek-flash,deepseek-v4-pro").split(
  ",",
);

let model = null;
for (const id of CANDIDATES) {
  const m = models.getModel("deepseek", id.trim());
  if (m) {
    model = m;
    console.log(`  ✅ 命中：${id.trim()}`);
    break;
  }
  console.log(`  ·  没有 ${id.trim()}`);
}

if (!model) {
  console.log("  ❌ 候选名单全都没命中");
  console.log("  deepseek 下可用的模型有：");
  for (const m of models.getModels("deepseek")) console.log("    - " + m.id);
  process.exit(1);
}

// 打印模型的关键字段，看看它背后用的是哪套 API
for (const k of [
  "id",
  "name",
  "provider",
  "api",
  "contextWindow",
  "maxTokens",
  "reasoning",
]) {
  if (model[k] !== undefined) console.log(`     ${k}: ${JSON.stringify(model[k])}`);
}

// ── 3. 跑一个最小 agent（还没有工具）──────────────────────
console.log("\n=== 3. 跑最小 agent ===");

const agent = new Agent({
  initialState: {
    systemPrompt: "你是一个简洁的中文助手。",
    model,
  },
  // ★ 0.87 里这个是必需的：把「怎么调模型」交给 models 集合
  streamFn: models.streamSimple.bind(models),
});

// 订阅框架的事件流
const SHOW = new Set([
  "agent_start",
  "turn_start",
  "turn_end",
  "agent_end",
  "tool_execution_start",
  "tool_execution_end",
]);

agent.subscribe((event) => {
  if (SHOW.has(event.type)) console.log(`  [事件] ${event.type}`);

  // 流式吐字：一个 chunk 一个 chunk 地来
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent?.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

console.log("");
await agent.prompt("用一句话介绍你自己");

console.log("\n\n=== 4. 结束 ===");
console.log(`  对话共 ${agent.state.messages.length} 条消息`);