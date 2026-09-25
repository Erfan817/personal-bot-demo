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

/** 发布事件（单个订阅者出错不影响其他订阅者）
 *
 * 注意：try/catch 只能接住【同步】异常。订阅 async 函数时它返回 Promise，
 * rejection 必须单独接住 —— 否则就是 unhandledRejection，静默漏掉。
 */
export function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      const r = fn(payload);
      if (r && typeof r.catch === "function") {
        r.catch((e) =>
          console.error(`[events] "${event}" 订阅者出错: ${e.message}`),
        );
      }
    } catch (e) {
      console.error(`[events] "${event}" 订阅者出错: ${e.message}`);
    }
  }
}

/**
 * 事件清单（约定）：
 *   step       {chatId, n}                        进入第 N 轮
 *   tool_call  {chatId, name, args, result}       工具被调用
 *   answer     {chatId, text}                     最终回答
 *   deliver    {chatId, text}                     调度层的定时推送
 *
 * ★ 每个事件都带 chatId —— 路由是订阅者自己的事，但标识必须由源头带上。
 *   早期 answer/tool_call 不带会话标识，靠「渠道串行」保证不串话；
 *   第二个渠道一接进来就必然串（工具过程发进另一个会话）。
 */