#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# 运维 · 心跳自愈
# ═══════════════════════════════════════════════════════════
# 由 cron 每 5 分钟跑一次。
#
# 逻辑：
#   bot 每分钟写一次 data/heartbeat（毫秒时间戳）
#   如果这个时间戳超过 MAX_AGE 秒没更新 -> 判定卡死 -> 重启服务
#
# 为什么 systemd 的 Restart=always 不够：
#   它只能处理【进程退出】。进程活着但卡死时，systemd 认为一切正常。
#
# 安装（root 的 crontab）：
#   */5 * * * * /home/azureuser/erifane-bot/scripts/healthcheck.sh
# ═══════════════════════════════════════════════════════════

set -u

HEARTBEAT="/home/azureuser/erifane-bot/data/heartbeat"
SERVICE="erifane-bot"
MAX_AGE=300 # 5 分钟没心跳就认为卡死
TAG="erifane-healthcheck"

now=$(date +%s)

# ── 心跳文件不存在 ──
if [ ! -f "$HEARTBEAT" ]; then
  logger -t "$TAG" "心跳文件不存在 —— 重启 $SERVICE"
  systemctl restart "$SERVICE"
  exit 0
fi

# ── 心跳内容异常 ──
last=$(tr -dc '0-9' <"$HEARTBEAT")
if [ -z "$last" ]; then
  logger -t "$TAG" "心跳内容异常 —— 重启 $SERVICE"
  systemctl restart "$SERVICE"
  exit 0
fi

# ── 心跳里存的是毫秒 ──
age=$((now - last / 1000))

if [ "$age" -gt "$MAX_AGE" ]; then
  logger -t "$TAG" "心跳已 ${age}s 未更新（阈值 ${MAX_AGE}s）—— 重启 $SERVICE"
  systemctl restart "$SERVICE"
  exit 0
fi

# 正常就静默 —— 否则每 5 分钟一条日志会淹掉系统日志
exit 0