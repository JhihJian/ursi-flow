#!/bin/bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
RUN_DIR="${URSI_BROWSER_RUN_DIR:-/run/ursi/agent/browser}"
PROFILE="$RUN_DIR/profile"
mkdir -p "$RUN_DIR" "$PROFILE"

find_chromium() {
  local path
  path="$(find /ms-playwright -type f \( -name chrome -o -name chromium \) -perm -111 2>/dev/null | head -1 || true)"
  if [[ -n "$path" ]]; then
    printf '%s' "$path"
    return 0
  fi
  command -v chromium || command -v chromium-browser || command -v google-chrome
}

chrome="$(find_chromium)"
pids=()
cleanup() {
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Xvfb writes the display number after accepting connections. Wait for that
# notification before starting clients, including on a fresh filesystem.
coproc XVFB { exec Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp -ac -displayfd 1 2>"$RUN_DIR/xvfb.log"; }
pids+=("$XVFB_PID")
if ! read -r -t 8 -u "${XVFB[0]}" display_number; then
  echo 'browser-stack: Xvfb did not become ready' >&2
  exit 1
fi
x11vnc -display "$DISPLAY" -rfbport 5900 -shared -forever -nopw -localhost >"$RUN_DIR/x11vnc.log" 2>&1 &
pids+=("$!")
websockify 6080 127.0.0.1:5900 >"$RUN_DIR/websockify.log" 2>&1 &
pids+=("$!")
rm -f "$PROFILE"/Singleton{Lock,Socket,Cookie}
"$chrome" \
  --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \
  --disable-infobars --user-data-dir="$PROFILE" --window-size=1920,1080 \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 about:blank \
  >"$RUN_DIR/chromium.log" 2>&1 &
pids+=("$!")

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    echo 'browser-stack: ready' >&2
    wait -n "${pids[@]}"
    exit 1
  fi
  sleep 0.5
done
echo 'browser-stack: Chromium CDP did not become ready' >&2
exit 1
