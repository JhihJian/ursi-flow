#!/bin/sh
set -eu
# cat 保留原始二进制。只有收到 TCP 写方向 EOF 后才会产生尾包。
cat
printf '\nfixture-tail-after-eof\n'
