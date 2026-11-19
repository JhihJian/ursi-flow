#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -lt 2 ]; then
  echo "usage: $0 <ursi-session-service-binary> <output-dir> [--manifest PATH ...] [--bundles PATH ...]" >&2
  echo "       JSON definitions add bundles, required_capabilities, services, endpoints and readiness." >&2
  exit 2
fi
runtime_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$runtime_dir/scripts/build_bundle.py" "$@"
