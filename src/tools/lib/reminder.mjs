/**
 * 纯函数：提醒任务的增删 + cron 的人类可读化
 * ═══════════════════════════════════════════════════
 * remind_me 工具的可测内核：不碰文件、不碰网络，离线单测。
 */

/** 新增或替换（同名覆盖 —— 让「把提醒改到 8 点」等于一次 create） */
export function upsertJob(jobs, job) {
  const i = jobs.findIndex((j) => j.name === job.name);
  if (i === -1) return { jobs: [...jobs, job], replaced: false };
  const next = [...jobs];
  next[i] = job;
  return { jobs: next, replaced: true };
}

/** 按名字删除；没找到时返回 removed: false，由上层决定怎么提示 */
export function removeJob(jobs, name) {
  const next = jobs.filter((j) => j.name !== name);
  return { jobs: next, removed: next.length !== jobs.length };
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * 把解析后的 cron 翻译成人话，翻不动的返回 null（调用方回退原始表达式）。
 * 只翻「每天 / 每周几 + 固定时刻」这类常见形态；
 * 涉及日期、月份或展开后时刻太多的，直接交还给 cron 原文 —— 宁可难看，不可翻错。
 */
export function describeCron(cron) {
  if (!cron) return null;
  if (cron.month.size !== 12 || cron.domRestricted) return null;

  const times = [];
  for (const h of [...cron.hour].sort((a, b) => a - b)) {
    for (const m of [...cron.minute].sort((a, b) => a - b)) {
      times.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  if (times.length === 0 || times.length > 10) return null;
  const t = times.join("、");

  if (!cron.dowRestricted) return `每天 ${t}`;
  const days = [...cron.dayOfWeek]
    .sort((a, b) => a - b)
    .map((d) => `周${WEEK[d] ?? d}`)
    .join("、");
  return `每${days} ${t}`;
}
