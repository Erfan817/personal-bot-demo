/**
 * 协议层 · 飞书渠道
 * ═══════════════════════════════════════════════════════════
 * 三件事：
 *   1. 飞书来的消息  -> 过桥接层闸门 -> 交给大脑
 *   2. 大脑的事件    -> 发到飞书（用户主动问的）
 *   3. deliver 事件  -> 发到指定会话（调度层定时推的）
 *
 * ★ 3 秒约束（飞书官方要求）
 *   长连接收到事件后必须【3 秒内处理完成且不抛异常】，否则超时重推。
 *   agent 跑一轮要好几秒 —— 所以：
 *     收到 -> 过闸门 -> 入队 -> 【立刻 return】
 *     后台 worker 慢慢跑 -> 跑完主动发消息回去
 * ═══════════════════════════════════════════════════════════
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { runAgent } from "../brain/loop.mjs";
import { on } from "../events.mjs";
import { config } from "../config.mjs";
import { admit, shapeReply, isConfigured } from "../gateway/index.mjs";

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

  // ══════ 出站 ①：用户主动问 -> 大脑事件 -> 发回当前会话 ══════
  let currentChatId = null;
  let toolLog = [];

  on("tool_call", ({ name, args, result }) => {
    toolLog.push(`🔧 ${name}(${JSON.stringify(args)})\n   ↳ ${result}`);
  });

  on("answer", async (text) => {
    const chatId = currentChatId;
    const body = [...toolLog, "", text].join("\n").trim();
    toolLog = [];
    currentChatId = null;

    if (!chatId || !body) return;
    await deliver(client, chatId, body);
  });

  // ══════ 出站 ②：调度层定时推送 -> 指定会话 ══════
  on("deliver", async ({ chatId, text }) => {
    await deliver(client, chatId, text);
  });

  // ══════ 入站：串行队列 ══════
  const queue = [];
  let working = false;

  async function worker() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        currentChatId = job.chatId;
        toolLog = [];
        try {
          await runAgent(job.text, { chatId: job.chatId });
        } catch (e) {
          await deliver(client, job.chatId, `❌ 出错了：${e.message}`);
          currentChatId = null;
        }
      }
    } finally {
      working = false;
    }
  }

  // ══════ 启动长连接 ══════
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
          queue.push({ chatId: msg.chat_id, text: text.trim() });
          worker().catch((e) =>
            console.error("[feishu] worker 异常:", e.message),
          );
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