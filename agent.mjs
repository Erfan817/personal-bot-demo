#!/usr/bin/env node
/**
 * Erifane Bot · 第 1 步：最小 agent 循环
 * ────────────────────────────────────────────────────────────
 * 这个文件只有一个目的：让你亲眼看见 agent 是怎么转起来的。
 * 它故意不依赖任何框架 —— 核心循环只有 20 行。
 *
 * 运行：
 *   node agent.mjs "帮我算一下 123 * 456"
 *
 * 两种模式（自动选择）：
 *   设了 DEEPSEEK_API_KEY  -> 调用真实模型
 *   没设                    -> 用假模型（mock），先跑通流程，零成本
 *
 * 强制用假模型：  MOCK=1 node agent.mjs "你好"
 * 换模型：        MODEL=kimi-k2 BASE_URL=https://api.moonshot.cn/v1 node agent.mjs "..."
 */

// ─────────────────────────────────────────────
// 1. 配置 —— 全部走环境变量，以后换模型不用改代码
// ─────────────────────────────────────────────
const API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const BASE_URL = process.env.BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.MODEL ?? "deepseek-chat";
const MOCK = process.env.MOCK === "1" || API_KEY === "";
const MAX_STEPS = 5; // 最多几轮工具调用，防止死循环

// ─────────────────────────────────────────────
// 2. 工具层 —— 这里就是你的「白名单」
//    只有定义在 TOOLS 里的工具，模型才能调用
// ─────────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "calc",
      description: "计算一个数学表达式。用户问「123 乘 456 等于多少」这类问题时使用。",
      parameters: {
        type: "object",
        properties: {
          expr: { type: "string", description: "纯数学表达式，例如 123 * 456" },
        },
        required: ["expr"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "now",
      description: "获取服务器当前时间（北京时间）。",
      parameters: { type: "object", properties: {} },
    },
  },
];

// 工具的真正实现
const HANDLERS = {
  calc({ expr }) {
    // 输入校验：只允许数字和运算符 —— 这是工具层的第一道防线
    if (!/^[0-9+\-*/(). ]+$/.test(expr)) {
      return "拒绝执行：表达式含非法字符（只允许 0-9 和 + - * / ( )）";
    }
    try {
      return String(Function(`"use strict"; return (${expr})`)());
    } catch (e) {
      return `计算出错：${e.message}`;
    }
  },
  now() {
    return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  },
};

// ─────────────────────────────────────────────
// 3. 模型层 —— 可替换的「大脑」
// ─────────────────────────────────────────────
async function callModel(messages) {
  if (MOCK) return mockModel(messages);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS }),
  });

  if (!res.ok) {
    throw new Error(`模型请求失败 HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

// 假模型：模拟「先要工具，再给答案」两步，用来验证流程是否打通
function mockModel(messages) {
  const last = messages[messages.length - 1];
  if (last.role === "tool") {
    return { role: "assistant", content: `好，算出来了，结果是 ${last.content}` };
  }
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_mock_1",
        type: "function",
        function: {
          name: "calc",
          arguments: JSON.stringify({ expr: "123 * 456" }),
        },
      },
    ],
  };
}

// ─────────────────────────────────────────────
// 4. agent 循环 —— 整个程序的心脏
// ─────────────────────────────────────────────
async function run(userInput) {
  const messages = [{ role: "user", content: userInput }];

  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(`\n── 第 ${step} 轮 ──`);

    const msg = await callModel(messages);
    messages.push(msg);

    // 没有再要工具 -> 说明它给答案了，结束
    if (!msg.tool_calls?.length) {
      console.log(`\n🤖 ${msg.content}`);
      return;
    }

    // 它想调工具 -> 逐个执行
    for (const call of msg.tool_calls) {
      const { name, arguments: rawArgs } = call.function;
      const args = safeParse(rawArgs);

      console.log(`🔧 ${name}(${JSON.stringify(args)})`);

      const handler = HANDLERS[name]; // ← 白名单检查
      const result = handler
        ? handler(args)
        : `拒绝：工具 ${name} 不在白名单里`;

      console.log(`   ↳ ${result}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  console.log(`\n⚠️ 达到最大轮数 ${MAX_STEPS}，强制停止`);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────
// 5. 入口
// ─────────────────────────────────────────────
const input = process.argv.slice(2).join(" ") || "帮我算一下 123 * 456";

console.log(MOCK ? "【假模型模式 · 不花钱】" : `【真实模型：${MODEL}】`);
console.log(`👤 ${input}`);

run(input).catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});