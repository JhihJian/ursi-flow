#!/usr/bin/env bash
# ursi-flow 单机发布：构建、渲染配置、安装服务单元、重启、冒烟。
# 用法：deploy/deploy.sh [--no-build] [--force]
#   --no-build  跳过构建，只重渲染配置并重启（改配置时用）
#   --force     工作区有未提交改动也继续
# Linux 用 systemd 用户单元，macOS 用 launchd 用户代理。
# 参数：复制 deploy/deploy.env.example 为 deploy/deploy.env 后按需修改。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# macOS 非交互 SSH 的 PATH 不含 Homebrew，构建期需要 node/npm/cargo；
# node@24 是 keg-only，必须排在 /opt/homebrew/bin 里的 node@22 前面。
if [ "$(uname -s)" = Darwin ]; then
  PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
  export PATH
fi

if [ -f "$ROOT/deploy/deploy.env" ]; then . "$ROOT/deploy/deploy.env"; fi

NODE="${NODE:-$(command -v node || true)}"
CADDY="${CADDY:-$(command -v caddy || true)}"
URSI_HOME="${URSI_HOME:-$HOME/.ursi}"
ENTRY_ADDR="${ENTRY_ADDR:-:8095}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
TODO_PORT="${TODO_PORT:-8090}"
SSH_PORT="${SSH_PORT:-8091}"
FLOW_PORT="${FLOW_PORT:-8094}"
PI_WEB_PORT="${PI_WEB_PORT:-8093}"
FS_PORT="${FS_PORT:-8199}"
# launchd 单元里的 PATH：后台代理不继承登录 shell 的环境。
SERVICE_PATH="${SERVICE_PATH:-/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

ENTRY_CONFIG="$URSI_HOME/deploy/Caddyfile"
SERVICES=(
  entry
  todo-web
  ssh-web
  flow-web
  pi-web
  fs-web
)
BACKEND_PORTS=("$TODO_PORT" "$SSH_PORT" "$FLOW_PORT" "$PI_WEB_PORT" "$FS_PORT")

NO_BUILD=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Linux)
    SUPERVISOR=systemd
    SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    TEMPLATE_DIR="$ROOT/deploy/units"
    ;;
  Darwin)
    SUPERVISOR=launchd
    SERVICE_DIR="$HOME/Library/LaunchAgents"
    TEMPLATE_DIR="$ROOT/deploy/launchd"
    LAUNCHD_DOMAIN="user/$(id -u)"
    ;;
  *)
    echo "不支持的系统：$(uname -s)，本脚本只支持 Linux（systemd）与 macOS（launchd）" >&2
    exit 1
    ;;
esac

log() { printf '\n== %s\n' "$*"; }
fail() { echo "失败：$*" >&2; exit 1; }

# 服务标识：systemd 是单元文件名，launchd 是代理标签。
service_id() {
  case "$SUPERVISOR" in
    systemd) echo "ursi-$1.service" ;;
    launchd) echo "com.ursi.$1" ;;
  esac
}

# 单元文件路径：launchd 只加载 ~/Library/LaunchAgents 下的 *.plist。
service_path() {
  local id
  id=$(service_id "$1")
  case "$SUPERVISOR" in
    systemd) echo "$SERVICE_DIR/$id" ;;
    launchd) echo "$SERVICE_DIR/$id.plist" ;;
  esac
}

service_template() {
  case "$SUPERVISOR" in
    systemd) echo "$TEMPLATE_DIR/ursi-$1.service" ;;
    launchd) echo "$TEMPLATE_DIR/com.ursi.$1.plist" ;;
  esac
}

render() {
  local src="$1" dst="$2"
  sed \
    -e "s|@ROOT@|$ROOT|g" \
    -e "s|@NODE@|$NODE|g" \
    -e "s|@CADDY@|$CADDY|g" \
    -e "s|@ENTRY_CONFIG@|$ENTRY_CONFIG|g" \
    -e "s|@URSI_HOME@|$URSI_HOME|g" \
    -e "s|@SERVICE_PATH@|$SERVICE_PATH|g" \
    -e "s|@ENTRY_ADDR@|$ENTRY_ADDR|g" \
    -e "s|@BACKEND_HOST@|$BACKEND_HOST|g" \
    -e "s|@TODO_PORT@|$TODO_PORT|g" \
    -e "s|@SSH_PORT@|$SSH_PORT|g" \
    -e "s|@FLOW_PORT@|$FLOW_PORT|g" \
    -e "s|@PI_WEB_PORT@|$PI_WEB_PORT|g" \
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
  if [ "$SUPERVISOR" = systemd ]; then
    systemctl --user show-environment >/dev/null 2>&1 ||
      fail "当前会话没有 systemd 用户实例，本方案按用户级单元部署"
    if command -v loginctl >/dev/null 2>&1 &&
      ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
      echo "警告：linger 未开启，注销后服务会停止；可执行 sudo loginctl enable-linger $(id -un)"
    fi
  else
    # launchd 的 user/ 域必须可引导；没有图形登录会话时只能装在这个域里。
    launchctl print "$LAUNCHD_DOMAIN" >/dev/null 2>&1 ||
      fail "launchd 用户域 $LAUNCHD_DOMAIN 不可用，无法安装代理"
    if [ "$(stat -f%Su /dev/console 2>/dev/null)" != "$(id -un)" ]; then
      echo "警告：当前没有图形登录会话，代理只在用户域内运行，重启后需要登录一次才会自启"
    fi
  fi
  local free_mb
  free_mb=$(df -Pm "$ROOT" | awk 'NR==2{print $4}')
  if [ "${free_mb:-0}" -lt 2048 ]; then
    echo "警告：构建盘可用空间 ${free_mb}MB，低于 2GB，构建可能失败"
  fi
  if [ "$FORCE" -eq 0 ] && [ -d "$ROOT/.git" ] &&
    [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    fail "工作区有未提交改动，确认后加 --force"
  fi
  echo "system=$(uname -s) supervisor=$SUPERVISOR node=$NODE caddy=$CADDY"
  echo "root=$ROOT ursi_home=$URSI_HOME entry=$ENTRY_ADDR backend=$BACKEND_HOST"
}

stop_services() {
  log "停止服务"
  local name
  case "$SUPERVISOR" in
    systemd)
      local units=()
      for name in "${SERVICES[@]}"; do units+=("$(service_id "$name")"); done
      systemctl --user stop "${units[@]}" 2>/dev/null || true
      ;;
    launchd)
      for name in "${SERVICES[@]}"; do
        launchctl bootout "$LAUNCHD_DOMAIN/$(service_id "$name")" 2>/dev/null || true
      done
      ;;
  esac
}

build() {
  log "构建"
  if [ "$ROOT/package-lock.json" -nt "$ROOT/node_modules/.package-lock.json" ]; then
    (cd "$ROOT" && npm ci)
  fi
  # shell-web 直接 import 各模块入口；sandbox-web 的样式 exports 指向 dist，先构一次。
  (cd "$ROOT/apps/ursi-sandbox/web" && npm run build:css)
  npm --prefix "$ROOT" run build:shell-web
  if [ ! -d "$ROOT/apps/ursi-flow/node_modules" ] ||
    [ "$ROOT/apps/ursi-flow/package-lock.json" -nt "$ROOT/apps/ursi-flow/node_modules/.package-lock.json" ]; then
    (cd "$ROOT/apps/ursi-flow" && npm ci)
  fi
  (cd "$ROOT/apps/ursi-flow" && npm run build)
  cargo build --release --manifest-path "$ROOT/apps/todo-web/Cargo.toml"
  cargo build --release --manifest-path "$ROOT/apps/ssh-web/Cargo.toml"
}

# 一次性状态迁移：旧的两个状态目录并进 pi-web，已在目标位置的不覆盖。
migrate_state() {
  local target="$URSI_HOME/pi-web"
  mkdir -p "$target/sessions"
  if [ -f "$URSI_HOME/pi-manager/homes.json" ] && [ ! -f "$target/homes.json" ]; then
    cp "$URSI_HOME/pi-manager/homes.json" "$target/homes.json"
    log "迁移 homes.json"
  fi
  if [ -f "$URSI_HOME/pi-sessions/prefs.json" ] && [ ! -f "$target/sessions/prefs.json" ]; then
    cp "$URSI_HOME/pi-sessions/prefs.json" "$target/sessions/prefs.json"
    log "迁移 sessions/prefs.json"
  fi
}

install_services() {
  log "渲染配置并安装服务"
  mkdir -p "$SERVICE_DIR" "$(dirname "$ENTRY_CONFIG")"
  mkdir -p "$URSI_HOME"/{todo,ssh,flow,flow-web,fs-web,pi-web/sessions}
  # 日志目录只服务 launchd：systemd 侧走 journal。
  if [ "$SUPERVISOR" = launchd ]; then mkdir -p "$URSI_HOME/logs"; fi
  migrate_state
  render "$ROOT/deploy/Caddyfile.tmpl" "$ENTRY_CONFIG"
  "$CADDY" validate --config "$ENTRY_CONFIG" --adapter caddyfile >/dev/null
  local name
  for name in "${SERVICES[@]}"; do
    render "$(service_template "$name")" "$(service_path "$name")"
  done
  case "$SUPERVISOR" in
    systemd)
      systemctl --user daemon-reload
      for name in "${SERVICES[@]}"; do
        systemctl --user enable --now "$(service_id "$name")"
      done
      ;;
    launchd)
      for name in "${SERVICES[@]}"; do
        launchctl bootstrap "$LAUNCHD_DOMAIN" "$(service_path "$name")" ||
          fail "bootstrap $(service_id "$name") 失败，用 launchctl print 查看原因"
      done
      ;;
  esac
}

wait_http() {
  local url="$1"
  for _ in $(seq 1 30); do
    # 冒烟只打回环地址，不吃 ALL_PROXY 之类的代理设置。
    if curl -fsS --noproxy '*' -o /dev/null "$url"; then return 0; fi
    sleep 1
  done
  fail "冒烟超时：$url"
}

listening_addrs() {
  local port="$1"
  case "$SUPERVISOR" in
    systemd) ss -ltnH "sport = :$port" | awk '{print $4}' ;;
    launchd) lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' ;;
  esac
}

smoke() {
  log "冒烟"
  local base="http://127.0.0.1:${ENTRY_ADDR##*:}"
  wait_http "$base/"
  local path
  for path in \
    /api/health \
    /api/ssh-web/health \
    /api/flow-web/flows \
    /api/pi/api/health \
    /api/fs-web/workspaces; do
    wait_http "$base$path"
    echo "ok $path"
  done

  local port addr
  for port in "${BACKEND_PORTS[@]}"; do
    while read -r addr; do
      [ -n "$addr" ] || continue
      case "$addr" in
        127.0.0.1:*|\[::1\]:*|"$BACKEND_HOST"*) ;;
        *) fail "端口 $port 监听了 $addr，应只绑 $BACKEND_HOST" ;;
      esac
    done < <(listening_addrs "$port")
  done
  echo "后端端口均只绑 $BACKEND_HOST"
}

status() {
  local name
  case "$SUPERVISOR" in
    systemd)
      local units=()
      for name in "${SERVICES[@]}"; do units+=("$(service_id "$name")"); done
      systemctl --user list-units --no-pager "${units[@]}"
      ;;
    launchd)
      for name in "${SERVICES[@]}"; do
        printf '%s: ' "$(service_id "$name")"
        launchctl print "$LAUNCHD_DOMAIN/$(service_id "$name")" 2>/dev/null |
          awk -F'= ' '/^\tstate = /{gsub(/ /, "", $2); print $2; found=1} END{if (!found) print "未加载"}'
      done
      ;;
  esac
}

preflight
stop_services
[ "$NO_BUILD" -eq 1 ] || build
install_services
smoke

log "完成"
status
