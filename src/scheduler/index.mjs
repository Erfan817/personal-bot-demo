/**
 * 调度层 —— 到点自动干活
 * ═══════════════════════════════════════════════════
 *   每 30 秒看一眼时钟
 *     ↓
 *   有没有任务的 cron 命中了当前这一分钟？
 *     ↓ 有
 *   入【全局串行队列】（brain/queue.mjs —— 和用户消息同一条队，
 *   早报跑着的时候你发消息，排队等，而不是两条 agent 同时跑）
 *     ↓
 *   emit("deliver", { chatId, text })
 *     ↓
 *   渠道层负责发出去
 *
 * 任务清单来自 data/jobs.json（运行时配置），支持热重载：
 * 改完文件不用重启服务，下一 tick 自动生效。
 *
 * 错过触发分钟的处理（misfire）：任务自带策略 ——
 *   · 内容型（默认）过期无意义，跳过；
 *   · 时间型（remind_me 建的提醒）misfire: "catchup"，启动时补发最近一次。
 *     例：「8:00 提醒我吃药」，服务 7:58-8:20 重启，8:20 启动时补发。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCron, matches } from "./cron.mjs";
import { scanMissed } from "./misfire.mjs";
import { defaultJobs } from "./jobs.mjs";
import { config } from "../config.mjs";
import { emit } from "../events.mjs";
import { enqueueAgentJob } from "../brain/queue.mjs";
import { overLimit, noteBlocked, usedTokens } from "../brain/usage.mjs";

const JOBS_FILE = config.scheduler.jobsFile;

// 「上次检查到的分钟」要落盘：
//   · 同一分钟内服务重启 -> 读回来，不会把刚触发过的任务再打一遍
//   · lastTickMs 供 misfire 扫描定位「从哪里开始算错过」
const STATE_FILE = join(dirname(JOBS_FILE), "scheduler-state.json");

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      lastKey: typeof s.lastKey === "string" ? s.lastKey : null,
      lastTickMs: Number.isFinite(s.lastTickMs) ? s.lastTickMs : 0,
    };
  } catch {
    return { lastKey: null, lastTickMs: 0 }; // 不存在 / 损坏，都当「没有记录」
  }
}

function saveState(lastKey, lastTickMs) {
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ lastKey, lastTickMs }, null, 2) + "\n",
    );
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

  const boot = loadState();
  let lastKey = boot.lastKey;
  let lastTickMs = boot.lastTickMs;

  // ── 补发：错过触发分钟的「时间型」任务 ──
  // 只补最近一次（scanMissed 内部有窗口上限），带（补发）标记；
  // 内容型任务（早报）没有 misfire 字段，默认跳过 —— 过期的早报没有价值。
  if (lastTickMs && Date.now() - lastTickMs > 60_000) {
    const missed = scanMissed(jobs, lastTickMs + 1, Date.now());
    for (const [job, atMs] of missed) {
      if (job.misfire !== "catchup") continue;
      const at = new Date(atMs).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      });
      console.log(`[调度] ⏰ 补发「${job.name}」（原定 ${at}，服务当时不在线）`);
      fire(job, job.chatId ?? config.scheduler.defaultChatId, true);
    }
  }

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
    lastTickMs = Date.now();
    saveState(lastKey, lastTickMs);

    for (const job of jobs) {
      if (!matches(job.cronParsed, now)) continue;
      fire(job, job.chatId ?? config.scheduler.defaultChatId);
    }
  }

  function fire(job, chatId, missed = false) {
    if (!chatId) {
      console.error(`[调度] 「${job.name}」到点了，但没有 chatId`);
      return;
    }

    // 成本闸门：超额后定时任务停推（用户直接发消息不受影响）
    if (overLimit()) {
      console.error(
        `[调度] ⛔ 今日 token 额度已到（${usedTokens()}/${config.usage.dailyTokenLimit}），跳过「${job.name}」`,
      );
      noteBlocked();
      return;
    }

    console.log(`[调度] ⏰ 触发「${job.name}」${missed ? "（补发）" : ""}`);
    enqueueAgentJob({
      chatId,
      text: job.prompt,
      announce: false,
      onDone: ({ answer }) => {
        emit("deliver", {
          chatId,
          text: `📅 ${missed ? "（补发）" : ""}${job.name}\n\n${answer}`,
        });
      },
      onError: (e) =>
        console.error(`[调度] 「${job.name}」执行失败：${e.message}`),
    });
  }

  tick().catch((e) => console.error("[调度] tick 出错:", e.message));
  const timer = setInterval(() => {
    tick().catch((e) => console.error("[调度] tick 出错:", e.message));
  }, 30_000);

  return () => clearInterval(timer);
}
