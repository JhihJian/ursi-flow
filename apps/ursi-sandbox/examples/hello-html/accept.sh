#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${URSI_GATEWAY_URL:?}" "${SANDBOX_SPEC:?}" "${SSH_IDENTITY:?}"
: "${URSI_GATEWAY_KEY_FILE:-${URSI_GATEWAY_KEY:?set URSI_GATEWAY_KEY_FILE or URSI_GATEWAY_KEY}}"
export URSI_CLIENT_TIMEOUT_SECS=30
die() { echo "$*" >&2; exit 1; }
[[ -r $SANDBOX_SPEC && -r $SSH_IDENTITY ]] || die 'Cannot read spec or SSH identity'
develop=$(dirname -- "${BASH_SOURCE[0]}")/develop.sh
out=$(mktemp -d /tmp/hello-html.XXXXXXXX)
printf 'Download directory: %s\n' "$out"
id=
cleanup() {
  if [[ -n $id ]]; then
    ursi-sandbox-client gateway delete "$id" >/dev/null || echo "Check sandbox $id" >&2
  fi
  rm -f -- "$out/known_hosts"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

id=$(ursi-sandbox-client gateway create "$SANDBOX_SPEC" | jq -er '.result.id | strings | select(length > 0)')
printf 'Sandbox: %s\n' "$id"
deadline=$((SECONDS + 180))
while :; do
  status=$(ursi-sandbox-client gateway status "$id" | jq -ec '.result')
  if jq -e '.status == "running" and has("operation") and .operation == null' <<<"$status" >/dev/null; then break; fi
  jq -e '.status == "preparing" or .status == "running"' <<<"$status" >/dev/null || die 'Sandbox failed to start'
  (( SECONDS < deadline )) || die 'Timed out waiting for sandbox'
  sleep 1
done

address=$(ursi-sandbox-client gateway endpoints "$id" | jq -er '.result.endpoints[] | select(.name == "ssh") | .address')
[[ $address =~ ^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+):([0-9]+)$ ]] || die 'Invalid SSH address'
ssh_args=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$SSH_IDENTITY" "$out/known_hosts")
remote_sum=$(ursi-sandbox-client ssh "${ssh_args[@]}" "$develop" | jq -er 'select(.result.success) | .result.stdout')
ursi-sandbox-client sftp-get "${ssh_args[@]}" "$out/index.html" /ursi/workspace/hello-html/index.html >/dev/null
local_sum=$(cd "$out" && sha256sum index.html)
[[ $local_sum == "$remote_sum" ]] || die 'SHA-256 mismatch'
grep -Eq '^[[:space:]]*<h1>Hello World</h1>[[:space:]]*$' "$out/index.html" || die 'Missing Hello World heading'

ursi-sandbox-client gateway delete "$id" >/dev/null
deleted=$id
id=  # The Gateway has accepted deletion; only poll from here.
deadline=$((SECONDS + 180))
while :; do
  if ! error=$(ursi-sandbox-client gateway status "$deleted" 2>&1 >/dev/null); then
    jq -es 'length == 1 and (.[0] | .type == "error" and .message == "Gateway HTTP 404: not_found")' \
      <<<"$error" >/dev/null || die "Cannot confirm deletion of $deleted: $error"
    break
  fi
  (( SECONDS < deadline )) || die "Timed out waiting for deletion of $deleted"
  sleep 1
done
printf 'Verified: %s/index.html\n' "$out"
