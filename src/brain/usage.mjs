/**
 * 大脑层 · 用量与日额度
 * ═══════════════════════════════════════════════════
 * 一个会自己定时触发、还会联网的 agent，风险不是"看不见花了多少"，
 * 是没人拦着它花。所以额度闸门排在用量看板前面：
 *
 *   · 每轮运行后 recordRun() 累计当日 tokens / 成本 → data/usage.json
 *   · 调度层的定时任务触发前查 overLimit()：
 *       超了 → 跳过本次推送 + noteBlocked() 写一次 COST_ALERT（当天只写一次）
 *   · 用户直接发的消息不受闸门限制 —— 别把主人锁在门外
 *
 * 日期按服务器本地时间切零点；跨天第一条记录自动开新账。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.mjs";

// 测试替身：默认写 config 指定的文件，测试里可指到临时目录
let file = config.usage.file;
export function useStore(f) {
  file = f;
}

function alertFile() {
  return join(dirname(file), "COST_ALERT");
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load() {
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j.date === today()) {
        return {
          date: j.date,
          input: Number(j.input) || 0,
          output: Number(j.output) || 0,
          cost: Number(j.cost) || 0,
          runs: Number(j.runs) || 0,
          alerted: !!j.alerted,
        };
      }
      // 日期变了 -> 自动开新账
    } catch {
      // 损坏 -> 从零开始，别让统计问题挡住主流程
    }
  }
  return { date: today(), input: 0, output: 0, cost: 0, runs: 0, alerted: false };
}

function save(s) {
  try {
    writeFileSync(file, JSON.stringify(s));
  } catch (e) {
    console.error("[usage] 写入失败:", e.message);
  }
}

/** 每轮跑完记一笔（loop.mjs 调用） */
export function recordRun(u = {}) {
  const s = load();
  s.input += Number(u.input) || 0;
  s.output += Number(u.output) || 0;
  s.cost += Number(u.cost) || 0;
  s.runs += 1;
  save(s);
  return s;
}

/** 今日已用 tokens（输入 + 输出） */
export function usedTokens() {
  const s = load();
  return s.input + s.output;
}

/** 定时任务触发前的闸门。limit <= 0 或 NaN 视为不限额 */
export function overLimit(limit = config.usage.dailyTokenLimit) {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return usedTokens() >= limit;
}

/** 超额后写一次告警文件（当天只写一次），人工处理或等明天自动开新账 */
export function noteBlocked() {
  const s = load();
  if (s.alerted) return;
  s.alerted = true;
  save(s);

  const limit = config.usage.dailyTokenLimit;
  const body = [
    "═══ Erifane Bot 成本告警 ═══",
    `时间        : ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    `今日已用    : ${usedTokens()} tokens（$${s.cost.toFixed(4)}）`,
    `日额度      : ${limit} tokens`,
    "处置        : 定时推送已暂停（用户直接发消息不受影响）",
    "",
    "解除方式（任选其一）：",
    "  · 等明天 0 点自动开新账",
    "  · 调大 .env 里的 DAILY_TOKEN_LIMIT 后重启",
    `  · 直接删除本文件： rm ${alertFile()}`,
    "",
  ].join("\n");
  try {
    writeFileSync(alertFile(), body);
  } catch (e) {
    console.error("[usage] 写告警失败:", e.message);
  }
}
