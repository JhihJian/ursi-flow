#!/usr/bin/env bash
# ursi-flow 单机部署卸载。默认只移除服务单元与渲染出来的配置，数据与构建产物保留。
# Linux 移除 systemd 用户单元，macOS 移除 launchd 用户代理。
# 用法：deploy/uninstall.sh [--purge-build] [--purge-data --yes]
#   --purge-build       删除构建产物（node_modules、Rust target、各 web dist）
#   --purge-data --yes  删除 ursi home 下的运行数据，保留 flow 包与 backups
#                       ~/.pi/agent 与 CLI 共用，任何参数下都不删除
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/deploy/deploy.env" ]; then . "$ROOT/deploy/deploy.env"; fi

URSI_HOME="${URSI_HOME:-$HOME/.ursi}"
SERVICES=(
  entry
  todo-web
  ssh-web
  flow-web
  pi-web
  fs-web
)
DATA_DIRS=(
  "$URSI_HOME/todo"
  "$URSI_HOME/ssh"
  "$URSI_HOME/flow-web"
  "$URSI_HOME/fs-web"
  "$URSI_HOME/pi-web"
)

case "$(uname -s)" in
  Linux)
    SUPERVISOR=systemd
    SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    ;;
  Darwin)
    SUPERVISOR=launchd
    SERVICE_DIR="$HOME/Library/LaunchAgents"
    LAUNCHD_DOMAIN="user/$(id -u)"
    ;;
  *)
    echo "不支持的系统：$(uname -s)，本脚本只支持 Linux（systemd）与 macOS（launchd）" >&2
    exit 1
    ;;
esac

service_id() {
  case "$SUPERVISOR" in
    systemd) echo "ursi-$1.service" ;;
    launchd) echo "com.ursi.$1" ;;
  esac
}

# launchd 只加载 ~/Library/LaunchAgents 下的 *.plist，文件名带扩展名。
service_file() {
  local id
  id=$(service_id "$1")
  case "$SUPERVISOR" in
    systemd) echo "$SERVICE_DIR/$id" ;;
    launchd) echo "$SERVICE_DIR/$id.plist" ;;
  esac
}

PURGE_BUILD=0
PURGE_DATA=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --purge-build) PURGE_BUILD=1 ;;
    --purge-data) PURGE_DATA=1 ;;
    --yes) YES=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n== %s\n' "$*"; }

if [ "$PURGE_DATA" -eq 1 ] && [ "$YES" -ne 1 ]; then
  echo "删除运行数据需要同时加 --yes" >&2
  exit 2
fi

log "停止并移除服务单元"
names=()
for name in "${SERVICES[@]}"; do names+=("$(service_id "$name")"); done
case "$SUPERVISOR" in
  systemd)
    systemctl --user stop "${names[@]}" 2>/dev/null || true
    systemctl --user disable "${names[@]}" 2>/dev/null || true
    ;;
  launchd)
    for name in "${names[@]}"; do
      launchctl bootout "$LAUNCHD_DOMAIN/$name" 2>/dev/null || true
    done
    ;;
esac
for name in "${SERVICES[@]}"; do rm -f "$(service_file "$name")"; done
if [ "$SUPERVISOR" = systemd ]; then systemctl --user daemon-reload; fi

log "删除渲染出来的配置"
rm -rf "$URSI_HOME/deploy"

if [ "$PURGE_BUILD" -eq 1 ]; then
  log "删除构建产物"
  while IFS= read -r -d '' dir; do rm -rf "$dir"; done < <(
    find "$ROOT" -maxdepth 5 -type d -name node_modules -prune -print0
  )
  rm -rf "$ROOT/apps/todo-web/target" "$ROOT/apps/ssh-web/target" "$ROOT/apps/ursi-flow/dist"
  rm -rf "$ROOT/apps/shell-web/dist"
  find "$ROOT/apps" -maxdepth 3 -type d -path '*/web/dist' -prune -print0 |
    while IFS= read -r -d '' dir; do rm -rf "$dir"; done
else
  log "构建产物保留（删除加 --purge-build）"
fi

if [ "$PURGE_DATA" -eq 1 ]; then
  log "删除运行数据"
  echo "将删除："
  for dir in "${DATA_DIRS[@]}"; do
    if [ -e "$dir" ]; then echo "  $dir"; fi
  done
  for dir in "${DATA_DIRS[@]}"; do rm -rf "$dir"; done
  echo "已保留："
  if [ -e "$URSI_HOME/flow" ]; then echo "  $URSI_HOME/flow（Flow 包）"; fi
  if [ -e "$URSI_HOME/backups" ]; then echo "  $URSI_HOME/backups（备份）"; fi
  echo "  $HOME/.pi/agent（与 pi CLI 共用，需自行决定是否清理）"
else
  log "运行数据保留（删除加 --purge-data --yes）"
  for dir in "${DATA_DIRS[@]}"; do
    if [ -e "$dir" ]; then du -sh "$dir" 2>/dev/null || true; fi
  done
fi

log "完成"
echo "仓库目录 $ROOT 保留；删除仓库请自行操作。"
