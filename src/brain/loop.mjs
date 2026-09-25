/**
 * 大脑层 · agent 循环
 * ═══════════════════════════════════════════════════
 * 它自己不打印任何东西，只发事件。
 *
 * 两种运行模式：
 *   announce = true （默认）  用户主动问 -> 发过程事件（步骤/工具/回答）
 *   announce = false          调度层触发 -> 只返回结果，不推过程
 *
 * 为什么分开：定时任务推给用户时，不需要"🔧 now({})"这些过程噪音。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { config } from "../config.mjs";
import { emit } from "../events.mjs";
import { models, resolveModel } from "./models.mjs";
import { agentTools, isAllowed } from "../tools/index.mjs";
import { loadRecent, saveMessage } from "../memory/index.mjs";

/**
 * @param {string} userText
 * @param {{chatId?: string, announce?: boolean}} opts
 */
export async function runAgent(
  userText,
  { chatId = "cli", announce = true } = {},
) {
  let turn = 0;
  let answer = null;
  const pending = new Map(); // toolCallId -> { name, args }

  // ① 载入历史
  const history = loadRecent(chatId, config.memory.historyLimit);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(history),
      model: resolveModel(),
      tools: agentTools,
    },

    streamFn: models.streamSimple.bind(models),

    // ★ 白名单闸门
    beforeToolCall: async ({ toolCall }) => {
      if (!isAllowed(toolCall.name)) {
        return { block: true, reason: `工具 ${toolCall.name} 不在白名单里` };
      }
    },

    // 死循环保护
    shouldStopAfterTurn: async () => turn >= config.agent.maxSteps,
  });

  agent.subscribe((event) => {
    switch (event.type) {
      case "turn_start":
        turn += 1;
        if (announce) emit("step", turn);
        break;

      case "tool_execution_start":
        pending.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
        });
        break;

      case "tool_execution_end": {
        const info = pending.get(event.toolCallId) ?? {
          name: event.toolName,
          args: {},
        };
        pending.delete(event.toolCallId);

        if (announce) {
          emit("tool_call", {
            name: info.name,
            args: info.args,
            result:
              extractText(event.result) ||
              (event.isError ? "（执行出错）" : ""),
          });
        }
        break;
      }

      case "agent_end": {
        // 框架自己的错误一定要打出来 —— 不然出错时只看到"空回答"
        if (agent.state.errorMessage) {
          console.error("[brain] 框架报错:", agent.state.errorMessage);
        }

        const last = [...agent.state.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        answer = extractText(last);

        if (!answer) {
          answer = agent.state.errorMessage
            ? `⚠️ 模型调用失败：${agent.state.errorMessage}`
            : "⚠️ 没能生成回复（模型没有返回内容），请查看服务端日志。";
        }

        if (announce) emit("answer", answer);
        break;
      }
    }
  });

  await agent.prompt(userText);

  // ② 落盘
  saveMessage(chatId, "user", userText);
  if (answer) saveMessage(chatId, "assistant", answer);

  return { answer, messages: agent.state.messages };
}

/**
 * 把历史对话拼进 system prompt
 * ═══════════════════════════════════════════════════
 * 为什么【不】塞进 initialState.messages：
 *
 *   框架内部的 assistant 消息除 role/content 外还带
 *   provider / model / usage / stopReason 等字段。
 *   我们从 SQLite 还原的是简化对象，格式对不上时框架会静默丢弃，
 *   结果发给模型的是【连续两条 user 消息】—— 多数 API 直接拒绝。
 *   表现就是「回答是空的」，而且不报错（我们踩过这个坑）。
 *
 * 拼进 system prompt 的好处：
 *   · 不依赖框架内部格式
 *   · 以后换框架也不用改
 *   · 好调试 —— 直接能看见喂给模型的是什么
 */
function buildSystemPrompt(history) {
  const base = config.agent.systemPrompt;
  if (!history.length) return base;

  const lines = history
    .map((m) => `${m.role === "user" ? "用户" : "我"}：${m.content}`)
    .join("\n");

  return `${base}

【以下是你们之前的部分对话，按时间顺序，供你接上下文用】
${lines}
【对话记录结束】`;
}

/** 从消息 / 工具结果里抠出纯文本 */
function extractText(obj) {
  const c = obj?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}