#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <ursi-session-service-binary> <output-dir>" >&2
  exit 2
fi
runtime_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$runtime_dir/scripts/build_bundle.py" "$1" "$2"
