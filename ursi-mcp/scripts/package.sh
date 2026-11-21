#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) target=x86_64-unknown-linux-musl ;;
  Linux:aarch64) target=aarch64-unknown-linux-musl ;;
  *) printf '请在 Linux x86_64 或 ARM64 构建主机上运行\n' >&2; exit 1 ;;
esac

# 默认以本机 musl 工具链生成独立可执行文件。
export CC="${CC:-musl-gcc}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/app/target}"
mkdir -p -- "$CARGO_TARGET_DIR"
CARGO_TARGET_DIR=$(cd -- "$CARGO_TARGET_DIR" && pwd)
cargo build --locked --release --target "$target" --manifest-path "$root/app/Cargo.toml"
npm --prefix "$root/web" ci
npm --prefix "$root/web" run build:standalone
version=$(node -p 'require(process.argv[1]).version' "$root/web/package.json")
name="ursi-mcp-$version-$target"
output="${1:-$root/dist}"
mkdir -p -- "$output"
output=$(cd -- "$output" && pwd)
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
mkdir -- "$stage/$name"
install -m 0755 "$CARGO_TARGET_DIR/$target/release/ursi-mcpd" "$stage/$name/ursi-mcpd"
cp -R -- "$root/web/dist-standalone" "$stage/$name/web"
install -m 0644 "$root/app/DEPLOY.md" "$stage/$name/README.md"
install -m 0644 "$root/web/LICENSE.third-party" "$stage/$name/LICENSE.third-party"
tar -C "$stage" -czf "$output/$name.tar.gz" "$name"
(cd -- "$output" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
printf '%s\n' "$output/$name.tar.gz"
