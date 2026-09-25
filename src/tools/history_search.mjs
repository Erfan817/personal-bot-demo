/**
 * 工具 · 检索历史对话
 * ═══════════════════════════════════════════════════
 * 这是「长期记忆」的入口：agent 自己决定什么时候去翻旧账。
 *
 * 注意它的 description 写法 —— 要明确告诉模型
 * 「什么情况下该用它」，否则模型不会主动调用。
 */
import { Type } from "typebox";
import { searchHistory } from "../memory/index.mjs";

export default {
  name: "history_search",
  label: "检索历史对话",

  description:
    "在过去的对话记录里检索。当用户说「之前」「上次」「我告诉过你」「你还记得吗」" +
    "或者需要回忆早前聊过的内容时，必须用这个工具去翻，不要凭印象回答。",

  parameters: Type.Object({
    query: Type.String({ description: "检索关键词，至少 3 个字" }),
    limit: Type.Optional(
      Type.Number({ description: "返回几条结果，默认 5" }),
    ),
  }),

  async execute(toolCallId, params) {
    const rows = searchHistory(params.query, params.limit ?? 5);

    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: "历史记录里没有找到相关内容。" }],
      };
    }

    const text = rows
      .map((r) => {
        const t = new Date(r.created_at).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
        });
        const who = r.role === "user" ? "用户" : "我";
        return `[${t}] ${who}：${r.content}`;
      })
      .join("\n");

    return { content: [{ type: "text", text }] };
  },
};