# 独立网络观测验收

Linux 宿主机、Docker 29.1.4、本机 Unix socket。两套临时沙箱使用同一个测试镜像，分别运行 HTTP 服务。脚本先确认 A、B 和宿主的网络命名空间各不相同，再通过 Gateway 对 A 开始观测。测试未打开宿主抓包 socket。

## 复现

从 `ursi-sandbox/` 执行，仅在受信任的测试机上以特权运行已检查的二进制和测试脚本。若已有 `ursi-gateway-acceptance:local` 测试镜像，可跳过镜像构建。

```bash
cargo build --locked -p ursi-gateway -p ursi-observer
docker build -t ursi-gateway-acceptance:local gateway/tests/fixtures/docker
sudo -n python3 -I -B observer/tests/docker_acceptance.py
```

测试使用随机管理密钥、随机 Docker scope、临时数据库、独立 Observer 目录和随机 Gateway 端口。完成后只清理该 scope 的容器、卷和本轮临时目录。

## 实测结果

| 用例 | 判据与结果 |
| --- | --- |
| 双沙箱隔离、Gateway 重启 | 强杀 Gateway 后，A 向自身回环和 B 的 HTTP 服务发请求，B 另向自身回环发送独有标记。重启 Gateway 后停止同一次观测，下载并解析到 73 条 SLL2 记录（7685 字节）。A 的回环请求在 ifindex 1 有方向 4 和 0 的相同 TCP 序号和内容。ifindex 2 可见 A 的发出请求和 B 返回的 HTTP 200 与响应体。B 的私有回环标记未出现在文件内。 |
| 鉴权与控制 | 无凭据及错误凭据访问开始、查询、停止、下载均为 401。同沙箱重复开始及活动中下载均为 409。停止收尾后再次停止返回 200。 |
| 容器身份 | 停止容器后，旧观测以 `container_exited` 收尾。保数据重建后，沙箱代际、容器 ID 和新观测 ID 均改变，旧记录仍可查询。 |
| Observer 故障 | 强杀 Observer 后观测接口返回 503；沙箱仍能执行命令，并通过 Gateway 停止和重建。以原目录恢复 Observer 后，未收尾的记录为 `interrupted`，新容器可重新开始观测。 |
| 配额 | 8192 字节配额下以 `limited` 结束。下载得到 56 条可完整解析的记录，共 5802 字节，与状态里的报文数和字节数一致。 |
| 停止时的尾包 | 在 `unshare --net` 创建的空命名空间内启用 `lo`，单独运行 `udp_burst_immediate_stop_preserves_pcap_sequences`。接收端收齐连续 128 个 UDP 序号后立即停止，PCAP 中每个序号均出现两次，`kernel_drops=0`。 |

接口编号、包数和字节数为本次运行值。回归脚本校验方向、请求标记、响应内容与计数一致性，不依赖固定的网络时序。本轮临时容器和卷已清理；未进行生产部署或高负载无损测试。
