#!/usr/bin/env bash
# 同步 apps/pi-web 上游（fork JhihJian/pi-web 的 main 分支）。
# 用法：scripts/pi-web-sync.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! git remote | grep -qx pi-web; then
  git remote add pi-web https://github.com/JhihJian/pi-web
fi

git fetch pi-web
git subtree pull --prefix=apps/pi-web pi-web main --squash
