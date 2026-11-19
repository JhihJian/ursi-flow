#!/bin/bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
RUN_DIR="${URSI_BROWSER_RUN_DIR:-/run/ursi/browser}"
PROFILE="${URSI_BROWSER_PROFILE_DIR:-/ursi/workspace/.browser-profile}"
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
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac >"$RUN_DIR/xvfb.log" 2>&1 &
xvfb_pid=$!
x11vnc -display "$DISPLAY" -rfbport 5900 -shared -forever -nopw -localhost >"$RUN_DIR/x11vnc.log" 2>&1 &
vnc_pid=$!
websockify 6080 localhost:5900 >"$RUN_DIR/websockify.log" 2>&1 &
websockify_pid=$!
rm -f "$PROFILE"/Singleton{Lock,Socket,Cookie}
"$chrome" \
  --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \
  --disable-infobars --user-data-dir="$PROFILE" --window-size=1920,1080 \
  --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 about:blank \
  >"$RUN_DIR/chromium.log" 2>&1 &
chrome_pid=$!

cleanup() {
  kill "$chrome_pid" "$websockify_pid" "$vnc_pid" "$xvfb_pid" 2>/dev/null || true
  wait "$chrome_pid" "$websockify_pid" "$vnc_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9222/json/version >/dev/null; then
    echo 'browser-stack: ready' >&2
    wait "$chrome_pid"
    exit $?
  fi
  sleep 0.5
done
echo 'browser-stack: Chromium CDP did not become ready' >&2
exit 1
