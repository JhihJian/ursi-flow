#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${1:-}"
case "$profile" in
  ssh|pi) args=(-f "$root/builder/image/Dockerfile" --target "$profile");;
  browser) args=(-f "$root/builder/image-browser/Dockerfile");;
  *) echo "usage: $0 {ssh|pi|browser} [docker build options]" >&2; exit 2;;
esac
shift
exec docker build "${args[@]}" -t "ursi-runtime-${profile}:local" "$@" "$root"
