#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# 运维 · 心跳自愈
# ═══════════════════════════════════════════════════════════
# 由 systemd timer 每 5 分钟触发（不再用 cron —— 见下方说明）。
#
# 逻辑：
#   bot 每分钟写一次 data/heartbeat（毫秒时间戳）
#   时间戳超过 MAX_AGE 秒没更新 -> 判定卡死 -> 重启服务
#
# ★ 为什么要有「连续失败计数」和「告警阈值」
# ───────────────────────────────────────────────────────────
#   只看单次心跳就无脑重启，会遇到两种情况：
#     · 服务确实起不来（配置错、依赖挂）-> 每 5 分钟重启一次，
#       永远起不来，日志被刷爆，重启风暴反而掩盖了真正原因
#     · 磁盘满 / 内存耗尽 -> 重启也救不了，只会更糟
#
#   所以：连续 MAX_CONSECUTIVE 次异常后【停手】，
#        写一个 ALERT 文件并打日志 —— 把问题交给能解决它的人。
#        恢复正常后计数自动复位、告警自动清除。
#
# ★ 为什么从 cron 换成 systemd timer
# ───────────────────────────────────────────────────────────
#   cron 的弱点：脚本自己挂了没人知道，也没有日志归集。
#   systemd timer 的好处：
#     · 执行记录进 journal（journalctl -u erifane-healthcheck）
#     · systemctl list-timers 能看到下次触发时间
#     · 可用 OnFailure= 挂后续动作
#     · 备份那个还能用 Persistent=true（关机错过的任务开机补跑）
# ═══════════════════════════════════════════════════════════

set -u

BASE="/home/azureuser/erifane-bot"
HEARTBEAT="$BASE/data/heartbeat"
STATE_DIR="$BASE/data"
FAIL_FILE="$STATE_DIR/healthcheck-fails"
ALERT_FILE="$STATE_DIR/ALERT"

SERVICE="erifane-bot"
MAX_AGE=300          # 心跳超过 5 分钟没更新 = 卡死
MAX_CONSECUTIVE=3    # 连续 3 次异常就停手并告警
TAG="erifane-healthcheck"

log() { logger -t "$TAG" "$1"; echo "[$TAG] $1"; }

read_fails() { cat "$FAIL_FILE" 2>/dev/null || echo 0; }
write_fails() { echo "$1" >"$FAIL_FILE"; }

# ── 心跳正常：复位计数、清除告警 ──
reset() {
  local prev
  prev=$(read_fails)

  if [ "$prev" != "0" ]; then
    write_fails 0
    log "心跳恢复正常（之前连续失败 ${prev} 次），计数已复位"
  fi

  if [ -f "$ALERT_FILE" ]; then
    rm -f "$ALERT_FILE"
    log "✅ 服务已恢复，告警文件已清除"
  fi
}

# ── 心跳异常：计数，然后决定「重启」还是「告警停手」 ──
fail() {
  local reason="$1"
  local fails
  fails=$(($(read_fails) + 1))
  write_fails "$fails"

  if [ "$fails" -lt "$MAX_CONSECUTIVE" ]; then
    log "第 ${fails}/${MAX_CONSECUTIVE} 次异常（${reason}）—— 重启 $SERVICE"
    systemctl restart "$SERVICE"
    return
  fi

  # 达到阈值：不再重启，只告警（避免重启风暴）
  if [ ! -f "$ALERT_FILE" ]; then
    {
      echo "═══ Erifane Bot 告警 ═══"
      echo "时间        : $(date '+%F %T')"
      echo "原因        : $reason"
      echo "连续失败次数: $fails"
      echo "处置        : 已【停止自动重启】，等待人工介入"
      echo ""
      echo "排查："
      echo "  systemctl status $SERVICE"
      echo "  journalctl -u $SERVICE -n 100 --no-pager"
      echo "  df -h /            # 磁盘是否满了"
      echo "  free -h            # 内存是否耗尽"
      echo ""
      echo "恢复后删除本文件即可解除告警："
      echo "  rm $ALERT_FILE"
    } >"$ALERT_FILE"

    log "🚨 连续 ${fails} 次异常，已停止自动重启并写入告警：$ALERT_FILE"
  else
    log "🚨 连续 ${fails} 次异常，仍处于告警状态（不重启，避免重启风暴）"
  fi
}

# ══════════════════ 主流程 ══════════════════

now=$(date +%s)

if [ ! -f "$HEARTBEAT" ]; then
  fail "心跳文件不存在（可能从未成功启动）"
  exit 0
fi

last=$(tr -dc '0-9' <"$HEARTBEAT")
if [ -z "$last" ]; then
  fail "心跳文件内容异常"
  exit 0
fi

age=$((now - last / 1000)) # 心跳里存的是毫秒

if [ "$age" -gt "$MAX_AGE" ]; then
  fail "心跳已 ${age}s 未更新（阈值 ${MAX_AGE}s）"
  exit 0
fi

reset
exit 0