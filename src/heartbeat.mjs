/**
 * 运维 · 心跳
 * ═══════════════════════════════════════════════════
 * 每分钟往 data/heartbeat 写一个时间戳。
 *
 * 外部脚本（scripts/healthcheck.sh）定时检查这个文件：
 *   如果时间戳超过 5 分钟没更新 -> 认为进程卡死了 -> 重启服务
 *
 * 为什么需要它：
 *   systemd 的 Restart=always 只能处理【进程退出】。
 *   进程还活着但事件循环被卡住（比如某个网络调用永不返回）时，
 *   systemd 认为一切正常 —— 这叫"假活"。
 *   心跳是判定假活的唯一可靠办法。
 *
 * 为什么心跳能反映卡死：
 *   setInterval 依赖事件循环。事件循环被阻塞时，
 *   这个定时器就不会触发 —— 心跳自然就停了。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";

let timer = null;

export function startHeartbeat() {
  const file = config.heartbeatFile;
  mkdirSync(dirname(file), { recursive: true });

  const beat = () => {
    try {
      writeFileSync(file, String(Date.now()));
    } catch (e) {
      console.error("[heartbeat] 写入失败:", e.message);
    }
  };

  beat(); // 启动先写一次

  timer = setInterval(beat, 60_000);

  // 不阻止进程退出（cli 模式跑完就该退）
  timer.unref?.();

  console.log(`[heartbeat] 已启动，每 60s 写一次 → ${file}`);
  return () => {
    if (timer) clearInterval(timer);
  };
}

export function stopHeartbeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}