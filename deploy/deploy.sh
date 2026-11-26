#!/usr/bin/env bash
# ursi-flow 单机发布：构建、渲染配置、安装 systemd 用户单元、重启、冒烟。
# 用法：deploy/deploy.sh [--no-build] [--force]
#   --no-build  跳过构建，只重渲染配置并重启（改配置时用）
#   --force     工作区有未提交改动也继续
# 参数：复制 deploy/deploy.env.example 为 deploy/deploy.env 后按需修改。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/deploy/deploy.env" ]; then . "$ROOT/deploy/deploy.env"; fi

NODE="${NODE:-$(command -v node || true)}"
CADDY="${CADDY:-$(command -v caddy || true)}"
URSI_HOME="${URSI_HOME:-$HOME/.ursi}"
ENTRY_ADDR="${ENTRY_ADDR:-:8095}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
TODO_PORT="${TODO_PORT:-8090}"
SSH_PORT="${SSH_PORT:-8091}"
FLOW_PORT="${FLOW_PORT:-8094}"
PI_MANAGER_PORT="${PI_MANAGER_PORT:-8093}"
PI_SESSIONS_PORT="${PI_SESSIONS_PORT:-30200}"
FS_PORT="${FS_PORT:-8199}"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENTRY_CONFIG="$URSI_HOME/deploy/Caddyfile"
UNITS=(
  ursi-entry
  ursi-todo-web
  ursi-ssh-web
  ursi-flow-web
  ursi-pi-manager-web
  ursi-pi-sessions-web
  ursi-fs-web
)
BACKEND_PORTS=("$TODO_PORT" "$SSH_PORT" "$FLOW_PORT" "$PI_MANAGER_PORT" "$PI_SESSIONS_PORT" "$FS_PORT")

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

render() {
  local src="$1" dst="$2"
  sed \
    -e "s|@ROOT@|$ROOT|g" \
    -e "s|@NODE@|$NODE|g" \
    -e "s|@CADDY@|$CADDY|g" \
    -e "s|@ENTRY_CONFIG@|$ENTRY_CONFIG|g" \
    -e "s|@URSI_HOME@|$URSI_HOME|g" \
    -e "s|@ENTRY_ADDR@|$ENTRY_ADDR|g" \
    -e "s|@BACKEND_HOST@|$BACKEND_HOST|g" \
    -e "s|@TODO_PORT@|$TODO_PORT|g" \
    -e "s|@SSH_PORT@|$SSH_PORT|g" \
    -e "s|@FLOW_PORT@|$FLOW_PORT|g" \
    -e "s|@PI_MANAGER_PORT@|$PI_MANAGER_PORT|g" \
    -e "s|@PI_SESSIONS_PORT@|$PI_SESSIONS_PORT|g" \
    -e "s|@FS_PORT@|$FS_PORT|g" \
    "$src" >"$dst"
}

preflight() {
  log "预检"
  [ -n "$NODE" ] || fail "PATH 里没有 node"
  case "$("$NODE" -v)" in
    v24.*) ;;
    *) fail "需要 Node 24，当前是 $("$NODE" -v)" ;;
  esac
  [ -x "$CADDY" ] || fail "PATH 里没有 caddy"
  systemctl --user show-environment >/dev/null 2>&1 ||
    fail "当前会话没有 systemd 用户实例，本方案按用户级单元部署"
  if [ "$FORCE" -eq 0 ] && [ -d "$ROOT/.git" ] &&
    [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    fail "工作区有未提交改动，确认后加 --force"
  fi
  if command -v loginctl >/dev/null 2>&1 &&
    ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    echo "警告：linger 未开启，注销后服务会停止；可执行 sudo loginctl enable-linger $(id -un)"
  fi
  local free_mb
  free_mb=$(df -Pm "$ROOT" | awk 'NR==2{print $4}')
  if [ "${free_mb:-0}" -lt 2048 ]; then
    echo "警告：构建盘可用空间 ${free_mb}MB，低于 2GB，构建可能失败"
  fi
  echo "node=$NODE caddy=$CADDY root=$ROOT ursi_home=$URSI_HOME entry=$ENTRY_ADDR"
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
  log "渲染配置并安装单元"
  mkdir -p "$UNIT_DIR" "$(dirname "$ENTRY_CONFIG")"
  mkdir -p "$URSI_HOME"/{todo,ssh,flow,flow-web,fs-web,pi-manager,pi-sessions}
  render "$ROOT/deploy/Caddyfile.tmpl" "$ENTRY_CONFIG"
  "$CADDY" validate --config "$ENTRY_CONFIG" --adapter caddyfile >/dev/null
  for unit in "${UNITS[@]}"; do
    render "$ROOT/deploy/units/$unit.service" "$UNIT_DIR/$unit.service"
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
  local base="http://127.0.0.1:${ENTRY_ADDR##*:}"
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

  for port in "${BACKEND_PORTS[@]}"; do
    while read -r addr; do
      [ -n "$addr" ] || continue
      case "$addr" in
        127.0.0.1:*|\[::1\]:*|"$BACKEND_HOST"*) ;;
        *) fail "端口 $port 监听了 $addr，应只绑 $BACKEND_HOST" ;;
      esac
    done < <(ss -ltnH "sport = :$port" | awk '{print $4}')
  done
  echo "后端端口均只绑 $BACKEND_HOST"
}

preflight
stop_units
[ "$NO_BUILD" -eq 1 ] || build
install_units
smoke

log "完成"
systemctl --user list-units --no-pager "${UNITS[@]/%/.service}"
