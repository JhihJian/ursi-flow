#!/bin/sh
set -eu
# 只服务固定验收页面。读完请求头后响应，Content-Length 明确标识响应结束。
while IFS= read -r line; do
    case "$line" in
        "$(printf '\r')"|'') break ;;
    esac
done
printf 'HTTP/1.1 200 OK\r\nContent-Length: 19\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n'
cat /www/index.html
