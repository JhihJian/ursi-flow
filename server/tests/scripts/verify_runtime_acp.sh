#!/usr/bin/env bash
# Run from the Flow repository root. Requires a local Linux Docker bridge.
set -euo pipefail
umask 077
standalone=${1:?expected standalone build directory}
client="$standalone/target/debug/ursi-sandbox-client"
bundle="$standalone/dist/runtime-bundle.tar.gz"
image=$(docker image inspect -f '{{.Id}}' ursi-runtime-pi:local)
export CARGO_TARGET_DIR=/data/dev/ursi-flow/target
(cd "$standalone/dist" && sha256sum -c runtime-bundle.sha256)
sha256sum "$client" "$bundle"
printf 'image=%s\n' "$image"
work=$(mktemp -d /tmp/ursi-acp-check.XXXXXXXX)
name=${work##*/}
net= cid=
cleanup() {
    local rc=$?
    if [[ -n $cid ]]; then docker rm -fv "$cid" >/dev/null || rc=1; fi
    if [[ -n $net ]]; then docker network rm "$net" >/dev/null || rc=1; fi
    rm -rf -- "$work" || rc=1
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
net=$(docker network create --internal "$name")
cid=$(docker run -d --name "$name" --pull never --network "$net" --no-healthcheck \
    --tmpfs /run --tmpfs /ursi/workspace --entrypoint sleep "$image" infinity)
inside() { docker exec "$cid" "$@"; }
docker exec -i "$cid" tar xzf - -C /opt/ursi/runtime bin/ursi-session-service < "$bundle"
inside sha256sum /opt/ursi/runtime/bin/ursi-session-service
inside /usr/local/bin/pi --version
inside install -d -m 0700 /run/ursi/config /run/ursi/config/pi
inside install -d -o agent -g agent /ursi/workspace/repo
openssl rand -hex 32 > "$work/session-token"
docker exec -i "$cid" sh -c 'umask 077; tee /run/ursi/config/session-token >/dev/null' < "$work/session-token"
docker exec -i "$cid" sh -c 'umask 077; tee /run/ursi/config/session.json >/dev/null' <<'JSON'
{"provider":"acceptance","model":"fixed"}
JSON
docker exec -i "$cid" sh -c 'umask 077; tee /run/ursi/config/pi/models.json >/dev/null' <<'JSON'
{"providers":{"acceptance":{"baseUrl":"http://127.0.0.1:18080/v1","api":"openai-completions","apiKey":"local-fixture-only","models":[{"id":"fixed","name":"Fixed response"}]}}}
JSON
docker exec -i "$cid" sh -c 'tee /run/model.py >/dev/null' < server/tests/scripts/local_model_fixture.py
docker exec -d "$cid" sh -c 'exec python3 /run/model.py >/run/model.log 2>&1'
docker exec -d "$cid" /opt/ursi/runtime/bin/ursi-session-service
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$cid")
curl --noproxy '*' -fsS --retry 12 --retry-delay 1 --retry-connrefused --max-time 2 \
    "http://$ip:8765/healthz" >/dev/null
unset URSI_SESSION_TOKEN
export URSI_ACP_URL="ws://$ip:8765/acp" URSI_SESSION_TOKEN_FILE="$work/session-token"
export URSI_FLOW_REAL_ACP=1 URSI_CLIENT_TIMEOUT_SECS=45
cargo test --locked -p ursi-server --test real_runtime_acp -- --ignored --exact flow_runner_can_verify_real_runtime_acp
check_state() {
    inside sh -c 'cat /ursi/workspace/.ursi-state/*.json' | jq -es --argjson n "$1" '
      length == $n and all(.[]; .state == "closed" and .cwd == "/ursi/workspace/repo" and .cleanupFailed == false)' >/dev/null
    [[ $(inside grep -cx 'served fixed completion' /run/model.log) == "$1" ]]
    local remaining
    remaining=$(inside ls -A /run/ursi/sessions)
    [[ -z $remaining ]]
}
check_state 1
printf 'Flow: 1 completion, closed at fixed cwd\n'
acp() { "$client" acp "$@"; }
sid=$(acp new /ursi/workspace/repo | jq -er '.result.sessionId')
printf 'Reply ACP-OK.' > "$work/prompt"
acp prompt "$sid" "$work/prompt" | jq -es --arg sid "$sid" '
  (last | .type == "result" and .result.stopReason == "end_turn") and
  ([.[] | select(.type == "update" and .params.sessionId == $sid)
    | .params.update | select(.sessionUpdate == "agent_message_chunk") | .content.text] | join("") == "ACP-OK")' >/dev/null
acp close "$sid" >/dev/null
acp status "$sid" | jq -e --arg sid "$sid" '.result | .sessionId == $sid and .state == "closed" and has("pid") and .pid == null' >/dev/null
check_state 2
printf 'CLI: ACP-OK, end_turn, closed; 2 completions total, no session directories\n'
