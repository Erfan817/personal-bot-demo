/**
 * 桥接层 · 限频（令牌桶）
 * ═══════════════════════════════════════════════════
 * 令牌桶是限频的经典做法，比"每分钟最多 N 次"更平滑：
 *
 *   · 桶里有 capacity 个令牌
 *   · 以 refillPerSec 的速度持续补充
 *   · 每来一个请求，消耗 1 个
 *   · 桶空了就拒绝
 *
 * 好处：允许短时突发（桶里攒着的令牌），但长期速率被限制住。
 *
 * 为什么必须做：防止被刷爆，也防止一晚上烧光你的 API 额度。
 */
import { config } from "../config.mjs";

function createBucket(capacity, refillPerSec) {
  let tokens = capacity;
  let last = Date.now();

  return {
    take() {
      const now = Date.now();
      // 先按流逝的时间补令牌（上限是桶容量）
      tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
      last = now;

      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true, left: Math.floor(tokens) };
      }
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((1 - tokens) / refillPerSec)),
      };
    },
  };
}

// 每个用户一个桶
const buckets = new Map();

/**
 * @param {string} senderId
 * @returns {{ok: true, left: number} | {ok: false, retryAfter: number}}
 */
export function checkRate(senderId) {
  let bucket = buckets.get(senderId);
  if (!bucket) {
    bucket = createBucket(
      config.gateway.rateCapacity,
      config.gateway.rateRefillPerMin / 60,
    );
    buckets.set(senderId, bucket);
  }
  return bucket.take();
}