/**
 * 大脑层 · 全局串行队列
 * ═══════════════════════════════════════════════════
 * 为什么队列长在 brain 层而不是渠道层：串行是【全局】约束，不是飞书的私事。
 *
 * 之前队列内联在 feishu.mjs 里，调度器的 fire() 直接 await runAgent
 * 绕过了它 —— 早报跑着的时候用户发消息，就是两条 agent 循环在
 * 1 GiB 内存 / 2 vCPU 的机器上同时跑，还各自可能再调 web 工具。
 * 既打破「消息串行处理」的假设，也打破内存预算。
 *
 * 现在：渠道收到的消息和调度器触发的任务都从这里进，
 * 任何时刻最多一个 agent 循环在跑。
 */
import { runAgent } from "./loop.mjs";

const queue = [];
let working = false;

// 测试替身：默认真跑 runAgent，测试里可换成立即返回的假循环
let runner = runAgent;
export function setRunner(fn) {
  runner = fn;
}

/**
 * 排一个 agent 任务，串行执行。
 * job = { chatId, text, announce?, onDone?({answer}), onError?(err) }
 */
export function enqueueAgentJob(job) {
  queue.push(job);
  drain();
}

/** 当前排队长度（观测用） */
export function queueDepth() {
  return queue.length;
}

async function drain() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        const { answer } = await runner(job.text, {
          chatId: job.chatId,
          announce: job.announce ?? true,
        });
        job.onDone?.({ answer });
      } catch (e) {
        if (job.onError) job.onError(e);
        else console.error(`[queue] 任务执行异常（chatId=${job.chatId}）: ${e.message}`);
      }
    }
  } finally {
    working = false;
  }
}
