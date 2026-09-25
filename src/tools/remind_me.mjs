/**
 * 工具 · 自建提醒
 * ═══════════════════════════════════════════════════
 * 让「以后每天 21 点提醒我背单词」这句话真的落地。
 *
 * 为什么必须有这个工具：调度器只读 data/jobs.json，agent 原来没有任何
 * 写它的手段 —— 用户说「每天提醒我」，它只能嘴上答应，到点什么都不会
 * 发生（记忆库只存字，不会触发任何动作）。
 *
 * 生效路径：本工具原子改写 jobs.json → 调度器 30 秒内的热重载读到
 * → 下一个匹配的分钟触发推送。全程不用重启。
 *
 * 推送目标：SCHEDULE_CHAT_ID（与每日早报同一个会话）。
 */
import { Type } from "typebox";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { parseCron } from "../scheduler/cron.mjs";
import { defaultJobs } from "../scheduler/jobs.mjs";
import { describeCron, upsertJob, removeJob } from "./lib/reminder.mjs";
import { config } from "../config.mjs";

const JOBS_FILE = config.scheduler.jobsFile;

/** 读任务清单；文件缺失退回内置默认（和调度器 loadJobs 的语义一致） */
function readJobs() {
  if (existsSync(JOBS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(JOBS_FILE, "utf8"));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 损坏就当空表；下一次 create/remove 写回时会被修复
    }
  }
  return defaultJobs.map((j) => ({ ...j }));
}

// 原子写：先写临时文件再 rename，调度器的热重载永远不会读到半截 JSON
function writeJobs(jobs) {
  const tmp = `${JOBS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(jobs, null, 2) + "\n");
  renameSync(tmp, JOBS_FILE);
}

const out = (text) => ({ content: [{ type: "text", text }] });

export default {
  name: "remind_me",
  label: "定时提醒",

  description:
    "创建、查看或删除定时提醒 —— 这是唯一能到点【主动】给用户发消息的手段。" +
    "用户说「每天 X 点提醒我…」「工作日早上…提醒」「以后每周一…」「取消那个提醒」「我有哪些提醒」时必须用它；" +
    "不要只口头答应 —— 光答应到点不会发生任何事。" +
    "时间用 5 段 cron（分 时 日 月 周，服务器是北京时间）：" +
    "每天21点=「0 21 * * *」，工作日早上7点半=「30 7 * * 1-5」，每周一9点=「0 9 * * 1」。" +
    "创建成功后把生效时间告诉用户；用户没起名字就根据内容起个短名字。",

  parameters: Type.Object({
    action: Type.String({
      description: "create 创建 / list 查看全部 / remove 删除",
    }),
    name: Type.Optional(
      Type.String({ description: "提醒的短名字；create 不填就按内容起名，remove 必填" }),
    ),
    cron: Type.Optional(
      Type.String({ description: "5 段 cron：分 时 日 月 周，如 0 21 * * *" }),
    ),
    text: Type.Optional(
      Type.String({ description: "提醒什么（create 时必填）" }),
    ),
  }),

  async execute(toolCallId, params) {
    const action = String(params.action ?? "").trim();

    if (action === "list") {
      const jobs = readJobs();
      if (!jobs.length) return out("现在没有任何提醒。");
      const lines = jobs.map((j) => {
        let when;
        try {
          when = describeCron(parseCron(j.cron)) ?? j.cron;
        } catch {
          when = `${j.cron}（格式有误）`;
        }
        return `· ${j.name} — ${when}${j.enabled === false ? "（已停用）" : ""}`;
      });
      return out(`当前有 ${jobs.length} 个提醒：\n${lines.join("\n")}`);
    }

    if (action === "remove") {
      const name = String(params.name ?? "").trim();
      if (!name) throw new Error("remove 需要提供要删除的提醒名字");
      const r = removeJob(readJobs(), name);
      if (!r.removed) {
        const names = readJobs().map((j) => j.name).join("、") || "（空）";
        throw new Error(`没有叫「${name}」的提醒。现有的：${names}`);
      }
      writeJobs(r.jobs);
      return out(`✅ 已删除提醒「${name}」，30 秒内生效。`);
    }

    if (action === "create") {
      const text = String(params.text ?? "").trim();
      const cronExpr = String(params.cron ?? "").trim();
      if (!text) throw new Error("create 需要提供提醒内容 text");
      if (!cronExpr) throw new Error("create 需要提供 cron 时间（5 段：分 时 日 月 周）");

      let parsed;
      try {
        parsed = parseCron(cronExpr);
      } catch (e) {
        throw new Error(`cron 不合法：${e.message}（示例：每天21点 = 0 21 * * *）`);
      }

      if (!config.scheduler.defaultChatId) {
        throw new Error(
          "没有配置 SCHEDULE_CHAT_ID —— 提醒建了也不知道推给谁，先让用户在 .env 里补上",
        );
      }

      const name = String(params.name ?? "").trim() || text.slice(0, 12);
      const job = {
        name,
        cron: cronExpr,
        prompt: `定时提醒到点了。请直接、简短地提醒用户：${text}`,
        enabled: true,
        // 提醒是「时间型」任务：服务重启跨过触发点也要补发，
        // 不然「8 点提醒我吃药」赶上一次重启就真的不响，还没人知道。
        misfire: "catchup",
      };
      const r = upsertJob(readJobs(), job);
      writeJobs(r.jobs);

      const when = describeCron(parsed) ?? cronExpr;
      return out(
        `✅ 已${r.replaced ? "更新" : "创建"}提醒「${name}」：${when}` +
          `（cron: ${cronExpr}）。任务清单热重载，下一个匹配的分钟自动推送。`,
      );
    }

    throw new Error("action 只支持 create / list / remove");
  },
};
