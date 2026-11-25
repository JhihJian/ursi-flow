#!/bin/sh
set -eu
# 每次启动都留出真实副作用已完成、Gateway 尚未提交就绪的故障注入窗口。
rm -f /tmp/fixture-ready
trap 'exit 0' TERM INT
sleep 5
# alpine:3.22 的 BusyBox 未编译 httpd applet，用 nc 提供同一 HTTP 探针。
nc -ll -p 8080 -e /fixture/httpd.sh &
nc -ll -p 9001 -e /fixture/echo.sh &
touch /tmp/fixture-ready
printf 'fixture-ready\n'
wait
