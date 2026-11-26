#!/usr/bin/env bash
# 清理 ursi-flow 部署产生的可回收占用：旧运行日志与 systemd 用户日志。
# 用法：deploy/prune.sh [--apply]
#   缺省只报告将删除什么，加 --apply 才执行。
# 参数：RUNS_RETENTION_DAYS、JOURNAL_RETENTION_DAYS、JOURNAL_MAX_SIZE，
# 可在 deploy/deploy.env 里覆盖。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/deploy/deploy.env" ]; then . "$ROOT/deploy/deploy.env"; fi

URSI_HOME="${URSI_HOME:-$HOME/.ursi}"
FLOW_WEB_RUNS="$URSI_HOME/flow-web/runs"
RUNS_RETENTION_DAYS="${RUNS_RETENTION_DAYS:-30}"
JOURNAL_RETENTION_DAYS="${JOURNAL_RETENTION_DAYS:-14}"
JOURNAL_MAX_SIZE="${JOURNAL_MAX_SIZE:-512M}"

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n== %s\n' "$*"; }

log "当前占用"
[ -d "$URSI_HOME" ] && du -sh "$URSI_HOME" 2>/dev/null || true
for dir in "$URSI_HOME"/*; do
  [ -d "$dir" ] && du -sh "$dir" 2>/dev/null || true
done
journalctl --user --disk-usage 2>/dev/null || true

log "运行日志保留 ${RUNS_RETENTION_DAYS} 天：$FLOW_WEB_RUNS"
if [ -d "$FLOW_WEB_RUNS" ]; then
  mapfile -t stale < <(find "$FLOW_WEB_RUNS" -mindepth 1 -maxdepth 1 -type d \
    -mtime +"$RUNS_RETENTION_DAYS" -printf '%f\n' | sort)
  if [ "${#stale[@]}" -eq 0 ]; then
    echo "没有过期运行"
  else
    printf '%s\n' "${stale[@]}"
    if [ "$APPLY" -eq 1 ]; then
      for id in "${stale[@]}"; do rm -rf "${FLOW_WEB_RUNS:?}/$id"; done
      echo "已删除 ${#stale[@]} 个运行"
    fi
  fi
else
  echo "目录不存在，跳过"
fi

log "systemd 用户日志：保留 ${JOURNAL_RETENTION_DAYS} 天，上限 ${JOURNAL_MAX_SIZE}"
if [ "$APPLY" -eq 1 ]; then
  journalctl --user --vacuum-time="${JOURNAL_RETENTION_DAYS}d" >/dev/null 2>&1 || true
  journalctl --user --vacuum-size="$JOURNAL_MAX_SIZE" >/dev/null 2>&1 || true
  journalctl --user --disk-usage 2>/dev/null || true
else
  echo "加 --apply 执行 vacuum"
fi

log "完成"
