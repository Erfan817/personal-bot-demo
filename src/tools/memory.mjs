/**
 * 工具 · 长期记忆卡
 * ═══════════════════════════════════════════════════
 * 「长期记忆」的读写口。为什么必须有它：messages 档案层只存对话原文，
 * 模型没有"把这件事提炼成一条长期信息"的手段 —— 用户说「记住…」，
 * 它只能嘴上答应，下次照样想不起来。
 *
 * 主题 = 卡名（健身 / 学习 / 饮食 / 工作 / 人物名…）：
 *   · 每轮 system prompt 会注入核心记忆卡，主题让它一眼知道有哪些卡
 *   · 用户聊到某主题（"我健身的事"）时按主题搜卡，聊什么从哪张卡里说
 *
 * add 是幂等的：内容相同的活跃卡会被【更新】而不是重复新建。
 * description 决定模型的行为 —— 什么时候必须存、什么时候必须查，
 * 这里的每个「必须」都是踩过"嘴上答应"的亏换来的。
 */
import { Type } from "typebox";
import {
  addMemory,
  listMemories,
  searchMemories,
  topicsSummary,
  getMemory,
  removeMemory,
} from "../memory/memories.mjs";

const out = (text) => ({ content: [{ type: "text", text }] });
const brief = (s, n = 60) => (String(s).length > n ? `${String(s).slice(0, n)}…` : s);

export default {
  name: "memory",
  label: "长期记忆卡",

  description:
    "长期记忆卡 —— 跨会话记住主人相关信息的唯一手段，按【主题】分卡（主题就是卡名：健身、学习、饮食、工作、人物名字…）。" +
    "add：对话里出现值得长期记住的信息时【必须主动】存卡 —— 主人的偏好、身份背景（叫什么/做什么/在哪）、计划与目标、" +
    "项目的持续进展、重要人物；用户说「记住…」「我以后…」时也用它。同一主题有新进展时仍用 add：" +
    "内容相同会自动更新原卡，不会重复开卡。" +
    "search：用户问到和主人有关的过去的事、或回答依赖主人的偏好/背景时，先按主题或关键词搜卡【再】回答，不要凭印象编。" +
    "list：看看有哪些卡、各存了什么。remove：先 list/search 拿到 id 再删。" +
    "宁精勿滥：只存【长期有效】的信息，一次性对话内容不要存卡。",

  parameters: Type.Object({
    action: Type.String({
      description: "add 存卡（自动更新去重）/ list 列卡 / search 搜卡 / remove 删卡",
    }),
    content: Type.Optional(
      Type.String({ description: "add：这张卡记什么，一句话说清（提炼后的意思，不是照抄原话）" }),
    ),
    topic: Type.Optional(
      Type.String({ description: "add：主题（卡名），一两个词，如 健身 / 学习 / 饮食；不填归入「日常」" }),
    ),
    keywords: Type.Optional(
      Type.String({
        description: "add：空格分隔的检索词（含同义词），如「橘猫 宠物 猫」—— 将来换个说法也能搜到",
      }),
    ),
    importance: Type.Optional(
      Type.Number({ description: "add：重要度 1~5，默认 3；身份/硬约束给 5，临时喜好给 2" }),
    ),
    query: Type.Optional(
      Type.String({ description: "search：主题词或关键词" }),
    ),
    topicFilter: Type.Optional(
      Type.String({ description: "search/list：只看某个主题的卡" }),
    ),
    id: Type.Optional(
      Type.Number({ description: "remove：要删除的卡的 id（先 list/search 拿到）" }),
    ),
  }),

  async execute(_toolCallId, params) {
    const action = String(params.action ?? "").trim();

    if (action === "add") {
      const content = String(params.content ?? "").trim();
      if (!content) throw new Error("add 需要提供 content（这张卡记什么）");
      const r = addMemory({
        chatId: "feishu",
        topic: params.topic,
        content,
        keywords: params.keywords,
        importance: params.importance,
      });
      return out(
        r.updated
          ? `✅ 已更新${params.topic ? `「${params.topic}」` : ""}记忆卡（未重复开卡）。`
          : `✅ 已记入${params.topic ? `「${params.topic}」` : ""}记忆卡。`,
      );
    }

    if (action === "list") {
      if (params.topicFilter) {
        const rows = listMemories({ topic: params.topicFilter });
        if (!rows.length) return out(`「${params.topicFilter}」主题下还没有记忆卡。`);
        return out(
          `「${params.topicFilter}」卡（${rows.length} 条）：\n` +
            rows.map((m) => `· (#${m.id}) ${m.content}`).join("\n"),
        );
      }
      const topics = topicsSummary();
      if (!topics.length) return out("还没有任何记忆卡。");
      const all = listMemories({});
      const byTopic = new Map(all.map((m) => [m.topic, []]));
      for (const m of all) byTopic.get(m.topic).push(m);
      return out(
        `共有 ${topics.reduce((s, t) => s + t.n, 0)} 张活跃记忆卡：\n` +
          topics
            .map((t) => {
              const cards = byTopic.get(t.topic) ?? [];
              return (
                `· [${t.topic}] ${t.n} 条：` +
                cards.map((m) => brief(m.content, 40)).join("；")
              );
            })
            .join("\n"),
      );
    }

    if (action === "search") {
      const query = String(params.query ?? "").trim();
      if (!query) throw new Error("search 需要提供 query（主题词或关键词）");
      const rows = searchMemories(query, {
        topic: params.topicFilter ?? null,
        limit: 5,
      });
      if (!rows.length) {
        return out(`没有搜到与「${query}」相关的记忆卡。`);
      }
      return out(
        `搜到 ${rows.length} 张相关记忆卡：\n` +
          rows.map((m) => `· [${m.topic}] (#${m.id}) ${m.content}`).join("\n"),
      );
    }

    if (action === "remove") {
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("remove 需要提供有效的 id（先 list 或 search 拿到）");
      }
      const row = getMemory(id);
      if (!row || !removeMemory(id)) {
        throw new Error(`没有 id=${id} 的记忆卡，先 list 确认一下。`);
      }
      return out(`✅ 已删除 [${row.topic}] 的记忆卡：${brief(row.content, 40)}`);
    }

    throw new Error("action 只支持 add / list / search / remove");
  },
};
