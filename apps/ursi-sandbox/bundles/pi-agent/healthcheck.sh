#!/bin/sh
set -eu
/ursi/healthcheck-ssh
exec curl --silent --fail --noproxy '*' --max-time 2 http://127.0.0.1:8765/healthz >/dev/null
