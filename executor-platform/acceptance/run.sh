#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
a=$PWD
repo=$(cd ../.. && pwd)
export CARGO_TARGET_DIR="$a/.build/target" CARGO_PROFILE_DEV_DEBUG=0
mkdir -p .build/runtime
"$repo/flow-host/node_modules/.bin/tsc" -p "$repo/flow-host/tsconfig.build.json" --outDir "$a/.build/runtime"
printf '{"type":"module"}\n' > .build/runtime/package.json
ln -sfnT "$repo/flow-host/node_modules" .build/runtime/node_modules
cargo build --locked --manifest-path "$repo/executor-platform/server/Cargo.toml" --bin ursi-executor-platform
cargo build --locked --manifest-path "$repo/workbench/server/Cargo.toml" --bin ursi-server
exec python3 -B e2e.py -v
