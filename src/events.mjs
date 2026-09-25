/**
 * 事件总线 —— 「大脑层」和「协议层」解耦的关键
 *
 * 大脑层不直接 console.log，它只负责「发事件」。
 * 谁在听（命令行 / 飞书 / 以后的任何渠道）谁负责展示。
 *
 * 这就是为什么同一个 agent 能同时服务 CLI 和飞书：
 * 换渠道 = 换一个「订阅者」，大脑一行都不用改。
 */
const listeners = new Map();

/** 订阅某个事件 */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
}

/** 发布事件（单个订阅者出错不影响其他订阅者） */
export function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[events] "${event}" 订阅者出错: ${e.message}`);
    }
  }
}

/**
 * 事件清单（约定）：
 *   step       {number}                      进入第 N 轮
 *   tool_call  {name, args, result}          工具被调用
 *   answer     {text}                        最终回答
 */