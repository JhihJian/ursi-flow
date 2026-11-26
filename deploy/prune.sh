#!/usr/bin/env bash
# 清理 ursi-flow 部署产生的可回收占用：旧运行日志与服务日志。
# 用法：deploy/prune.sh [--apply]
#   缺省只报告将删除什么，加 --apply 才执行。
# 参数：RUNS_RETENTION_DAYS、JOURNAL_RETENTION_DAYS、JOURNAL_MAX_SIZE，
# 可在 deploy/deploy.env 里覆盖。Linux 清理 systemd 用户日志，
# macOS 的代理日志写在 $URSI_HOME/logs 下，定期执行时一并查看。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/deploy/deploy.env" ]; then . "$ROOT/deploy/deploy.env"; fi

URSI_HOME="${URSI_HOME:-$HOME/.ursi}"
FLOW_WEB_RUNS="$URSI_HOME/flow-web/runs"
SERVICE_LOGS="$URSI_HOME/logs"
RUNS_RETENTION_DAYS="${RUNS_RETENTION_DAYS:-30}"
JOURNAL_RETENTION_DAYS="${JOURNAL_RETENTION_DAYS:-14}"
JOURNAL_MAX_SIZE="${JOURNAL_MAX_SIZE:-512M}"

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n== %s\n' "$*"; }

log "当前占用"
if [ -d "$URSI_HOME" ]; then du -sh "$URSI_HOME" 2>/dev/null || true; fi
for dir in "$URSI_HOME"/*; do
  if [ -d "$dir" ]; then du -sh "$dir" 2>/dev/null || true; fi
done
if command -v journalctl >/dev/null 2>&1; then
  journalctl --user --disk-usage 2>/dev/null || true
fi

log "运行日志保留 ${RUNS_RETENTION_DAYS} 天：$FLOW_WEB_RUNS"
if [ -d "$FLOW_WEB_RUNS" ]; then
  stale=$(find "$FLOW_WEB_RUNS" -mindepth 1 -maxdepth 1 -type d \
    -mtime +"$RUNS_RETENTION_DAYS" -exec basename {} \; | sort)
  if [ -z "$stale" ]; then
    echo "没有过期运行"
  else
    printf '%s\n' "$stale"
    if [ "$APPLY" -eq 1 ]; then
      printf '%s\n' "$stale" | while IFS= read -r id; do
        rm -rf "${FLOW_WEB_RUNS:?}/$id"
      done
      echo "已删除上面列出的运行"
    fi
  fi
else
  echo "目录不存在，跳过"
fi

if [ -d "$SERVICE_LOGS" ]; then
  log "服务日志：$SERVICE_LOGS"
  ls -lh "$SERVICE_LOGS" 2>/dev/null || true
fi

if command -v journalctl >/dev/null 2>&1; then
  log "systemd 用户日志：保留 ${JOURNAL_RETENTION_DAYS} 天，上限 ${JOURNAL_MAX_SIZE}"
  if [ "$APPLY" -eq 1 ]; then
    journalctl --user --vacuum-time="${JOURNAL_RETENTION_DAYS}d" >/dev/null 2>&1 || true
    journalctl --user --vacuum-size="$JOURNAL_MAX_SIZE" >/dev/null 2>&1 || true
    journalctl --user --disk-usage 2>/dev/null || true
  else
    echo "加 --apply 执行 vacuum"
  fi
fi

log "完成"
