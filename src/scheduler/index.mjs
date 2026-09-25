/**
 * 调度层 —— 到点自动干活
 * ═══════════════════════════════════════════════════
 *   每 30 秒看一眼时钟
 *     ↓
 *   有没有任务的 cron 命中了当前这一分钟？
 *     ↓ 有
 *   跑 agent（announce: false，不推过程噪音）
 *     ↓
 *   emit("deliver", { chatId, text })
 *     ↓
 *   渠道层负责发出去
 *
 * 任务清单来自 data/jobs.json（运行时配置），支持热重载：
 * 改完文件不用重启服务，下一 tick 自动生效。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCron, matches } from "./cron.mjs";
import { defaultJobs } from "./jobs.mjs";
import { config } from "../config.mjs";
import { emit } from "../events.mjs";
import { runAgent } from "../brain/loop.mjs";

const JOBS_FILE = config.scheduler.jobsFile;

// 「上次检查到的分钟」要落盘：
//   · 同一分钟内服务重启 -> 读回来，不会把刚触发过的任务再打一遍
//   · 重启恰好跨过触发分钟 -> 那一轮就错过了（早报这类内容，过点补发没有意义）
// 之前只放内存里，重启即失忆 —— 实测重启并不罕见，08:00 触发后重启会推两遍。
const STATE_FILE = join(dirname(JOBS_FILE), "scheduler-state.json");

function loadLastKey() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return typeof s.lastKey === "string" ? s.lastKey : null;
  } catch {
    return null; // 不存在 / 损坏，都当「没有记录」
  }
}

function saveLastKey(key) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ lastKey: key }, null, 2) + "\n");
  } catch (e) {
    console.error(`[调度] 写状态文件失败: ${e.message}`);
  }
}

/** 读任务清单；文件不存在就用内置默认，并把它写出去方便你改 */
function loadJobs() {
  if (existsSync(JOBS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(JOBS_FILE, "utf8"));
      if (Array.isArray(parsed)) return parsed;
      console.error("[调度] jobs.json 不是数组，已忽略");
    } catch (e) {
      console.error(`[调度] jobs.json 解析失败：${e.message}（用内置默认）`);
    }
  }

  // 首次运行：生成一份出来
  try {
    mkdirSync(dirname(JOBS_FILE), { recursive: true });
    writeFileSync(JOBS_FILE, JSON.stringify(defaultJobs, null, 2) + "\n");
    console.log(`[调度] 已生成任务清单 → ${JOBS_FILE}`);
    console.log("[调度] 以后改任务直接改这个文件，不用重启");
  } catch (e) {
    console.error("[调度] 写 jobs.json 失败:", e.message);
  }
  return defaultJobs;
}

/** 解析 + 过滤，返回可执行的任务列表 */
function prepare(raw) {
  const out = [];
  for (const j of raw) {
    if (j.enabled === false) continue;
    try {
      out.push({ ...j, cronParsed: parseCron(j.cron) });
    } catch (e) {
      console.error(`[调度] 「${j.name}」cron 配置有误：${e.message}`);
    }
  }
  return out;
}

export function startScheduler() {
  let jobs = prepare(loadJobs());
  let lastMtime = existsSync(JOBS_FILE) ? statSync(JOBS_FILE).mtimeMs : 0;

  console.log(
    `[调度] 启用 ${jobs.length} 个任务` +
      (jobs.length ? `：${jobs.map((j) => j.name).join("、")}` : ""),
  );

  // ── 启动时校验推送目标，别等到触发才发现不对 ──
  const target = config.scheduler.defaultChatId;
  if (!target) {
    console.warn("[调度] ⚠️  没配 SCHEDULE_CHAT_ID —— 定时任务不知道推给谁");
  } else if (!target.startsWith("oc_")) {
    console.warn(
      `[调度] ⚠️  SCHEDULE_CHAT_ID 看起来不对：「${target}」\n` +
        "        必须以 oc_ 开头（那是 chat_id）。ou_ 开头的是 open_id。",
    );
  }

  let lastKey = loadLastKey();

  /** 热重载：文件变了就重新读 */
  function maybeReload() {
    try {
      const m = statSync(JOBS_FILE).mtimeMs;
      if (m !== lastMtime) {
        lastMtime = m;
        jobs = prepare(loadJobs());
        console.log(
          `[调度] 任务清单有变化，已重新载入：${jobs.length} 个启用` +
            (jobs.length ? `（${jobs.map((j) => j.name).join("、")}）` : ""),
        );
      }
    } catch {
      /* 文件不存在就忽略 */
    }
  }

  async function tick() {
    maybeReload();

    const now = new Date();
    const key = `${now.getFullYear()}/${now.getMonth()}/${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    if (key === lastKey) return; // 同一分钟只检查一次（重启后靠状态文件续上）
    lastKey = key;
    saveLastKey(key);

    for (const job of jobs) {
      if (!matches(job.cronParsed, now)) continue;

      const chatId = job.chatId ?? config.scheduler.defaultChatId;
      if (!chatId) {
        console.error(`[调度] 「${job.name}」到点了，但没有 chatId`);
        continue;
      }

      console.log(`[调度] ⏰ 触发「${job.name}」`);
      fire(job, chatId).catch((e) =>
        console.error(`[调度] 「${job.name}」执行失败：${e.message}`),
      );
    }
  }

  async function fire(job, chatId) {
    const { answer } = await runAgent(job.prompt, {
      chatId,
      announce: false,
    });
    emit("deliver", {
      chatId,
      text: `📅 ${job.name}\n\n${answer}`,
    });
  }

  tick().catch((e) => console.error("[调度] tick 出错:", e.message));
  const timer = setInterval(() => {
    tick().catch((e) => console.error("[调度] tick 出错:", e.message));
  }, 30_000);

  return () => clearInterval(timer);
}