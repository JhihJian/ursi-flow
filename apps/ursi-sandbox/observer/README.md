# 观测一次沙箱的网络流量

`ursi-observer` 在 Linux Docker 宿主机采集一次容器运行的网络报文。管理员通过 Gateway 开始和停止观测，再按段下载 PCAP。沙箱内无需安装抓包工具。该服务尚未正式部署。

## 配对与权限

一份 Gateway（数据库、namespace 和本机 Docker daemon）配一个 Observer、一处专用持久目录和一个 Unix socket。观测记录只按沙箱 ID 和观测 UUID 寻址，不按 Gateway 身份分区。不同 Gateway 不可共用目录、socket 或访问组，也不要把旧目录改配给其他管理域。

- **Observer** 需要能访问目标的宿主机 PID、`/proc/<pid>/ns/net` 和 Gateway 使用的本机 Docker socket。内核须支持 `pidfd_open`；进入目标网络命名空间需要相应的 `CAP_SYS_ADMIN`，打开 `AF_PACKET` socket 需要 `CAP_NET_RAW`。宿主策略也须允许这些操作。示例以可信宿主 root 启动。
- **Gateway** 除原有 Docker 权限外，只需能遍历目录并连接 `observer.sock`，无需增加上述抓包能力。socket 本身不校验 Bearer 身份，能连接它的进程就是受信调用方。仅授权配对的 Gateway 服务账户；不要将目录、socket 或额外能力授予沙箱。
- **API 调用方** 使用 Gateway 管理员 Bearer key，无单独的只读或租户级观测身份。PCAP 可能包含明文协议的凭据和业务数据，状态也包含容器标识。请限制下载文件及备份的访问权限。

## 准备与启动

从 `apps/ursi-sandbox/` 构建。下面用 `ursi-observe-a` 表示已创建的专用组，Gateway 服务账户须在此组内，并在加入组后重新启动以取得组身份。特权进程应只运行管理员信任、普通用户无法修改的二进制。

```bash
cargo build --locked --release -p ursi-observer -p ursi-gateway
```

管理员在受信父目录下预建专用目录。模式 `2710` 中的 setgid 位让新 socket 继承目录的组，组成员只有目录遍历权限，不能列出文件或替换 socket。Observer 使用 `umask 077` 并将 socket 设置为 `0660`，PCAP 为 `0600`。若由 Observer 按默认权限创建目录，使用另一账户的 Gateway 可能连不上 socket。

```bash
sudo install -d -o root -g ursi-observe-a -m 2710 /var/lib/ursi-observe-a
sudo install -o root -g root -m 0755 target/release/ursi-observer /usr/local/sbin/ursi-observer
sudo env URSI_OBSERVER_DIR=/var/lib/ursi-observe-a \
  URSI_OBSERVER_LIMIT_BYTES=1073741824 /usr/local/sbin/ursi-observer
```

在另一终端核对目录和 socket 的属组、权限：

```bash
stat -c '%a %U:%G %n' /var/lib/ursi-observe-a{,/observer.sock}
```

按 [Gateway 启动说明](../gateway/README.md)准备服务身份、数据库、namespace 和本机 Docker 连接，在 **Gateway 进程环境** 设置 `URSI_GATEWAY_OBSERVER_SOCKET=/var/lib/ursi-observe-a/observer.sock` 后启动或重启。两侧路径必须指向同一个 socket。

| 进程 | 环境变量 | 含义 |
| --- | --- | --- |
| Observer | `URSI_OBSERVER_DIR` | 必填，专用绝对路径。进程独占 `owner.lock`，启动时重建遗留的 `observer.sock`。 |
| Observer | `URSI_OBSERVER_LIMIT_BYTES` | 单次观测的 PCAP 总字节上限，默认 1 GiB，最小 24 字节。每段最多 256 MiB。 |
| Gateway | `URSI_GATEWAY_OBSERVER_SOCKET` | 默认未设置，观测关闭。仅 `docker` 驱动支持，与隧道开关无关。 |

## 开始、停止与下载

本机示例使用 Bash、curl 和 jq。先设置 `URSI_GATEWAY_KEY` 和 `SANDBOX_ID`，后者须为 `status: running` 且 `operation: null` 的沙箱。跨非可信网络时，通过配置好 TLS 的 Gateway 入口访问。

```bash
base=http://127.0.0.1:8899/api/v1
auth=(-H "Authorization: Bearer ${URSI_GATEWAY_KEY:?}")
obs="$base/sandboxes/${SANDBOX_ID:?}/observations"
curl -fsS "${auth[@]}" "$base/capabilities" | jq .observer_enabled
result=$(curl -fsS "${auth[@]}" -X POST "$obs")
run=$(jq -er .observation_id <<<"$result")
url="$obs/$run"
curl -fsS "${auth[@]}" "$url" | jq '{observation_id,state,ended_ms,error}'
```

`observer_enabled: true` 只表明 Gateway 配置了接入。保存 `SANDBOX_ID` 和 `run`，服务没有观测列表接口。开始返回 `202 starting`；重复查询，看到 `ended_ms` 为空且 `state` 为 `running` 或 `degraded` 后再执行待观测的操作。`degraded` 表示已经发生丢包或截断。若初始化失败，查看 `state: error` 和 `error` 字段。

```bash
curl -fsS "${auth[@]}" -X POST "$url/stop" | jq '{state,ended_ms}'
curl -fsS "${auth[@]}" "$url" | jq '{state,ended_ms,reason,error,segments,packets,bytes,kernel_drops,queue_drops}'
```

停止返回 202 只表示停止请求已受理；重复查询，直到 `ended_ms` 非空或 `state` 为 `interrupted`。活动中下载会返回 409。正常 `stopped` 或 `limited` 终态下，已写分段可按编号下载。`error` 终态也可下载已有段，但文件可能只包含写入成功的前缀。下面在私有临时目录下载第 1 段，其余段按编号分别下载。

```bash
out=$(mktemp -d)
curl -fS "${auth[@]}" "$url/segments/1" -o "$out/capture-000001.pcap"
```

容器退出也会结束本次采集。相同容器再次启动或沙箱重建后要重新发起观测。停 Observer 服务前，先停止各次活动观测并等到收尾完成，再终止该进程（前台示例按 Ctrl-C）。要停用 Gateway 接入，移除 `URSI_GATEWAY_OBSERVER_SOCKET` 后重启 Gateway；单独关闭接入或重启 Gateway 不会停止正在运行的 Observer。

## 解读与留存

- 采集范围是目标网络命名空间的全部接口，包括回环。文件使用 SLL2（链路类型 276，snaplen 262144），记录的是 Linux 提供的报文及接口信息，不是原始以太网帧。TLS 不解密，HTTPS 应用内容仍是密文。
- 采集不按协议、端口或流向过滤，但仍可能丢包。检查内核丢包 `kernel_drops`、用户态队列丢包 `queue_drops` 及截断提示。`limited` 表示下一批记录放不进配额；`bytes` 包括 PCAP 文件头和记录头。`packets` 和 `bytes` 反映写入 PCAP 的数量，不能用来推算链路总流量。
- 若 Observer 异常退出，用原目录重启后，未写入结束时间且已失去租约的记录会显示 `interrupted`，`reason` 为 `observer_interrupted`。`segments` 从目录恢复，其余计数来自上次状态快照，可能落后于文件；最后一段的末条记录也可能不完整。下载成功只表示读到了已有文件，应逐段检查可解析的记录。
- 文件保存在 `<URSI_OBSERVER_DIR>/<sandbox_id>/<observation_id>/`。删除沙箱不会删除这些文件。单次配额不限制所有历史占用；服务没有自动留存清理或删除 API。由管理员监测磁盘、约定保留期，在确认观测已结束且下载完成后归档或删除相应观测目录。保留活动目录和服务锁文件。

双沙箱隔离、故障恢复和配额的实测结果见 [验收记录](./ACCEPTANCE.md)。接口字段和错误码见 [Gateway HTTP 契约](../gateway/CONTRACT.md#网络观测)。
