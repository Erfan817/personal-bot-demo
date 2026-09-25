/**
 * 协议层 · 飞书渠道
 * ═══════════════════════════════════════════════════════════
 * 三件事：
 *   1. 飞书来的消息  -> 过桥接层闸门 -> 入全局串行队列
 *   2. 大脑的事件    -> 按 chatId 路由 -> 发回对应会话
 *   3. deliver 事件  -> 发到指定会话（调度层定时推的）
 *
 * ★ 3 秒约束（飞书官方要求）
 *   长连接收到事件后必须【3 秒内处理完成且不抛异常】，否则超时重推。
 *   agent 跑一轮要好几秒 —— 所以：
 *     收到 -> 过闸门 -> 入队 -> 【立刻 return】
 *     后台 worker 慢慢跑 -> 跑完主动发消息回去
 *
 * ★ 会话标识必须跟着事件走
 *   answer / tool_call 事件自带 chatId（大脑层填的），这里只负责路由。
 *   早期版本用模块级 currentChatId 变量记「当前在服务谁」——
 *   单渠道 + 严格串行时碰巧正确，第二个渠道一进来就必然串话。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { on } from "../events.mjs";
import { config } from "../config.mjs";
import { admit, shapeReply, isConfigured } from "../gateway/index.mjs";
import { enqueueAgentJob } from "../brain/queue.mjs";

export function startFeishu() {
  const { appId, appSecret } = config.feishu;
  const client = new Lark.Client({ appId, appSecret });

  if (!isConfigured()) {
    console.warn(
      "\n⚠️  白名单是空的 —— 现在【所有人都会被拒绝】。\n" +
        "   给机器人发一条消息，日志里会打印你的 open_id，\n" +
        "   然后把它写进 .env：ALLOWED_USERS=ou_xxxx\n",
    );
  }

  // ══════ 出站 ①：大脑事件 -> 按 chatId 路由 ══════
  // 每个会话一份工具过程日志；answer 到达时拼上去一起发，然后清掉
  const toolLogs = new Map(); // chatId -> string[]

  on("tool_call", ({ chatId, name, args, result }) => {
    const log = toolLogs.get(chatId) ?? [];
    log.push(`🔧 ${name}(${JSON.stringify(args)})\n   ↳ ${result}`);
    toolLogs.set(chatId, log);
  });

  on("answer", async ({ chatId, text }) => {
    const lines = toolLogs.get(chatId) ?? [];
    toolLogs.delete(chatId);
    const body = [...lines, "", text].join("\n").trim();
    if (!chatId || !body) return;
    await deliver(client, chatId, body);
  });

  // ══════ 出站 ②：调度层定时推送 -> 指定会话 ══════
  on("deliver", async ({ chatId, text }) => {
    await deliver(client, chatId, text);
  });

  // ══════ 入站：过闸门 -> 入全局串行队列 -> 立刻返回 ══════
  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  console.log("【飞书】正在建立长连接…");

  return wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        // ⚠️ 必须 3 秒内 return 且不能抛异常
        try {
          const msg = data?.message;
          if (!msg || msg.message_type !== "text") return;

          const text = JSON.parse(msg.content ?? "{}").text ?? "";
          if (!text.trim()) return;

          const senderId =
            data?.sender?.sender_id?.open_id ??
            data?.sender?.sender_id?.user_id ??
            "unknown";

          // ── 过闸门 ──
          const verdict = admit({ senderId, messageId: msg.message_id });

          if (!verdict.ok) {
            console.log(
              `[feishu] 已拦截（${verdict.reason}） open_id=${senderId}`,
            );
            if (!verdict.silent) {
              await deliver(client, msg.chat_id, `⛔ ${verdict.reason}`);
            }
            return;
          }

          // 打印 chat_id —— 定时任务要用它
          console.log(`[feishu] 通过 ✓  open_id=${senderId}`);
          console.log(`         chat_id=${msg.chat_id}`);
          console.log(`         内容：${text}`);

          // 只入队，不 await —— 立刻返回让 SDK 去 ACK
          // 队列在 brain 层（全局串行）：调度器的任务也走同一条队
          const chatId = msg.chat_id;
          enqueueAgentJob({
            chatId,
            text: text.trim(),
            announce: true,
            onError: (e) => {
              console.error("[feishu] 任务执行异常:", e.message);
              deliver(client, chatId, `❌ 出错了：${e.message}`).catch(
                (err) => console.error("[feishu] 错误提示发送失败:", err.message),
              );
            },
          });
        } catch (e) {
          // 关键：绝不向外抛异常，否则飞书会重推
          console.error("[feishu] 处理事件出错:", e.message);
        }
      },
    }),
  });
}

/** 出站闸门：切开过长回复，逐条发送 */
async function deliver(client, chatId, text) {
  for (const piece of shapeReply(text)) {
    try {
      await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: piece }),
        },
      });
    } catch (e) {
      console.error("[feishu] 发送失败:", e.message);
    }
  }
}
