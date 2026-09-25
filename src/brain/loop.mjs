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
 *
 * ★ 所有事件都带 chatId：路由是渠道层的事，但标识必须由源头带上。
 *   事件本身不带会话、只靠「当前正在服务谁」的模块级变量来猜 ——
 *   两个渠道一接进来就必然串话。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { config } from "../config.mjs";
import { emit } from "../events.mjs";
import { models, resolveModel } from "./models.mjs";
import { agentTools, isAllowed } from "../tools/index.mjs";
import { loadRecent, saveMessage } from "../memory/index.mjs";
import { recordRun } from "./usage.mjs";

/**
 * @param {string} userText
 * @param {{chatId?: string, announce?: boolean, timeoutMs?: number}} opts
 */
export async function runAgent(
  userText,
  { chatId = "cli", announce = true, timeoutMs } = {},
) {
  // 超时值要防呆：NaN > 0 是 false，配错时逐级退回默认，
  // 绝不能把 NaN 交给 setTimeout —— 那会立刻触发、每轮都被"超时"
  const limit =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : config.agent.timeoutMs > 0
        ? config.agent.timeoutMs
        : 120_000;
  let turn = 0;
  let toolCount = 0;
  let answer = null;
  let timedOut = false;
  const pending = new Map(); // toolCallId -> { name, args }
  const t0 = Date.now();

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
        if (announce) emit("step", { chatId, n: turn });
        break;

      case "tool_execution_start":
        pending.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
        });
        break;

      case "tool_execution_end": {
        toolCount += 1;
        const info = pending.get(event.toolCallId) ?? {
          name: event.toolName,
          args: {},
        };
        pending.delete(event.toolCallId);

        if (announce) {
          emit("tool_call", {
            chatId,
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
          if (timedOut) {
            answer = `⏱️ 这条消息处理超过 ${Math.round(limit / 1000)} 秒仍未完成，已中止。请重试，或换个问法。`;
          } else {
            answer = agent.state.errorMessage
              ? `⚠️ 模型调用失败：${agent.state.errorMessage}`
              : "⚠️ 没能生成回复（模型没有返回内容），请查看服务端日志。";
          }
        }

        if (announce) emit("answer", { chatId, text: answer });
        break;
      }
    }
  });

  // 整体超时：到点 abort 当前运行。框架对 abort 的处理是走
  // handleRunFailure -> 照常发 agent_end，所以 prompt() 会正常返回，
  // 调用方（串行队列）不需要"放弃等待"，也就不会出现
  // 「迟到的回答串进下一条消息的会话」这种竞态。
  const timeout = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, limit);

  try {
    await agent.prompt(userText);
  } finally {
    clearTimeout(timeout);
  }

  // 兜底：正常路径 agent_end 里已经把超时提示写进 answer；
  // 万一 agent_end 没发（理论上不可能），也保证用户收到一条回音
  if (!answer && timedOut) {
    answer = `⏱️ 这条消息处理超过 ${Math.round(limit / 1000)} 秒仍未完成，已中止。请重试，或换个问法。`;
    if (announce) emit("answer", { chatId, text: answer });
  }

  // ② 结构化运行日志 + 用量累计
  // 一行看清每轮的形态与成本：会话、轮数、工具数、耗时、tokens、花费。
  // 「心跳正常但每轮很慢」这类问题，从此有数据可查；cost 也是成本看板的地基。
  const usage = sumUsage(agent.state.messages);
  recordRun(usage);
  console.log(
    `[run] chatId=${chatId} turns=${turn} tools=${toolCount}` +
      ` ms=${Date.now() - t0} in=${usage.input} out=${usage.output}` +
      ` cost=$${usage.cost.toFixed(4)}` +
      (timedOut ? " timeout" : agent.state.errorMessage ? " error" : " ok"),
  );

  // ③ 落盘
  saveMessage(chatId, "user", userText);
  if (answer) saveMessage(chatId, "assistant", answer);

  return { answer, messages: agent.state.messages };
}

/** 把框架消息里的 usage 累加起来（字段带兜底，别让统计本身炸掉主流程） */
function sumUsage(messages) {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const m of messages) {
    const u = m?.usage;
    if (!u) continue;
    input += Number(u.input ?? 0) || 0;
    output += Number(u.output ?? 0) || 0;
    cost += Number(u.cost?.total ?? 0) || 0;
  }
  return { input, output, cost };
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
