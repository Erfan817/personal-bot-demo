/**
 * 调度层 · 错过触发分钟的扫描
 * ═══════════════════════════════════════════════════
 * 纯函数：给定任务列表和时间窗，找出每个任务在窗内「最近一次」
 * 该触发而没触发的分钟。调用方按任务的 misfire 策略决定补不补：
 *
 *   · 内容型（早报）过期无意义        -> misfire: "skip"（默认），错过就错过
 *   · 时间型（提醒）过期了更该响      -> misfire: "catchup"，补发一次
 *
 * 窗口向前最多扫 capMinutes：服务挂了三天，也不会把三天的提醒
 * 一次性补成刷屏 —— 只补最近一次。当前分钟不扫，交给正常 tick。
 */
import { matches } from "./cron.mjs";

export function scanMissed(jobs, fromMs, toMs, capMinutes = 7 * 24 * 60) {
  const found = new Map(); // job -> 最近一次错过的分钟（epoch ms）
  if (!(toMs > fromMs)) return found;

  const startBoundary = Math.floor(fromMs / 60_000) * 60_000 + 60_000; // from 之后第一个整分钟
  const endExclusive = Math.floor(toMs / 60_000) * 60_000; // 当前分钟交给正常 tick
  const from = Math.max(startBoundary, endExclusive - capMinutes * 60_000);

  for (let m = from; m < endExclusive; m += 60_000) {
    const d = new Date(m);
    for (const job of jobs) {
      if (job.enabled === false) continue;
      try {
        if (matches(job.cronParsed, d)) found.set(job, m);
      } catch {
        // cron 不合法的任务在 prepare() 已经被滤掉，这里兜一层
      }
    }
  }
  return found;
}
