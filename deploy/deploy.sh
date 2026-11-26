#!/usr/bin/env bash
# ursi-flow 单机发布：构建、安装 systemd 用户单元、重启、冒烟。
# 用法：deploy/deploy.sh [--no-build] [--force]
#   --no-build  跳过构建，只重装单元并重启（改配置时用）
#   --force     工作区有未提交改动也继续
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node || true)}"
CADDY="${CADDY:-$(command -v caddy || true)}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(
  ursi-entry
  ursi-todo-web
  ursi-ssh-web
  ursi-flow-web
  ursi-pi-manager-web
  ursi-pi-sessions-web
  ursi-fs-web
)
LOOPBACK_PORTS=(8090 8091 8093 8094 8199 30200)

NO_BUILD=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n== %s\n' "$*"; }
fail() { echo "失败：$*" >&2; exit 1; }

preflight() {
  log "预检"
  [ -n "$NODE" ] || fail "PATH 里没有 node"
  case "$("$NODE" -v)" in
    v24.*) ;;
    *) fail "需要 Node 24，当前是 $("$NODE" -v)" ;;
  esac
  [ -x "$CADDY" ] || fail "PATH 里没有 caddy"
  if [ "$FORCE" -eq 0 ] && [ -d "$ROOT/.git" ] &&
    [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    fail "工作区有未提交改动，确认后加 --force"
  fi
  echo "node=$NODE caddy=$CADDY root=$ROOT"
}

stop_units() {
  log "停止单元"
  systemctl --user stop "${UNITS[@]/%/.service}" 2>/dev/null || true
}

build() {
  log "构建"
  if [ "$ROOT/package-lock.json" -nt "$ROOT/node_modules/.package-lock.json" ]; then
    (cd "$ROOT" && npm ci)
  fi
  npm --prefix "$ROOT" run build:shell-web
  (cd "$ROOT/apps/ursi-flow" && npm run build)
  cargo build --release --manifest-path "$ROOT/apps/todo-web/Cargo.toml"
  cargo build --release --manifest-path "$ROOT/apps/ssh-web/Cargo.toml"
}

install_units() {
  log "安装单元"
  mkdir -p "$UNIT_DIR"
  for unit in "${UNITS[@]}"; do
    sed -e "s|@ROOT@|$ROOT|g" -e "s|@NODE@|$NODE|g" -e "s|@CADDY@|$CADDY|g" \
      "$ROOT/deploy/units/$unit.service" >"$UNIT_DIR/$unit.service"
  done
  systemctl --user daemon-reload
  systemctl --user enable --now "${UNITS[@]/%/.service}"
}

wait_http() {
  local url="$1"
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "$url"; then return 0; fi
    sleep 1
  done
  fail "冒烟超时：$url"
}

smoke() {
  log "冒烟"
  local base="http://127.0.0.1:8095"
  wait_http "$base/"
  for path in \
    /api/health \
    /api/ssh-web/health \
    /api/flow-web/flows \
    /api/pi-sessions/health \
    /api/pi-manager/healthz \
    /api/fs-web/workspaces; do
    wait_http "$base$path"
    echo "ok $path"
  done

  for port in "${LOOPBACK_PORTS[@]}"; do
    while read -r addr; do
      [ -n "$addr" ] || continue
      case "$addr" in
        127.0.0.1:*|\[::1\]:*) ;;
        *) fail "端口 $port 监听了 $addr，应只绑回环" ;;
      esac
    done < <(ss -ltnH "sport = :$port" | awk '{print $4}')
  done
  echo "后端端口均只绑回环"
}

preflight
stop_units
[ "$NO_BUILD" -eq 1 ] || build
install_units
smoke

log "完成"
systemctl --user list-units --no-pager "${UNITS[@]/%/.service}"
