# 门店日结：从订单 CSV 到本机报表

运行一次即可从门店订单得到本机报表 `report.csv`。运行器通过 Gateway 新建 Docker 沙箱，用 `ursi-sandbox-client sftp-put` 上传 `close.py` 和 `orders.csv`，再通过 CLI 的 SSH 子命令以 `agent` 身份运行 `python3 close.py orders.csv report.csv`。报表经 `sftp-get` 下载，待沙箱和数据卷删除后交付。此流程只使用 SSH/SFTP 执行业务，无需模型密钥或 ACP 会话。

## 准备

使用 Linux 本机 Docker daemon、Python 3.10+、OpenSSH 客户端（`ssh`、`sftp`、`ssh-keygen`）和有 `sudo` 权限的账户。宿主必须能访问沙箱 SSH 端口，容器必须能访问宿主的 bundle 发布端口。请在受控网络中运行：临时 Gateway 和 bundle HTTP 服务会监听 `0.0.0.0` 的随机端口。root 用于创建 Runtime 所需的私有配置目录，请使用可信的源码、二进制、镜像和 bundle。

以下命令从 `ursi-sandbox/` 目录运行。已有正式构建产物时可以直接进入下一节；从源码构建需要 Rust 工具链和 Docker 构建权限：

```bash
cargo build --locked --bins
docker build -t ursi-runtime-pi:local runtime/image
runtime/scripts/build-bundle.sh target/debug/ursi-session-service dist
```

`examples/daily-close/` 下应有 `run.py`、`close.py`、示例订单 `orders.csv` 和独立的参考报表 `expected.csv`。后者只在宿主机校验时使用。

## 跑示例，直接拿报表

```bash
report=$(sudo python3 -I -B examples/daily-close/run.py) && printf '本机报表：%s\n' "$report"
```

进度写入标准错误。命令成功时，标准输出只有下载报表的绝对路径，例如 `/tmp/ursi-daily-close-xxxxxxxx/report.csv`。运行器会比对下载报表和 `expected.csv` 的 SHA-256，确认示例订单算出了预期结果。用表格软件打开该路径即可，也可以在同一终端查看或归档：

```bash
cat -- "$report"
# 按需保存在个人目录中，使用新目录以保留历次日结。
archive=$(mktemp -d "$HOME/daily-close-XXXXXXXX") && cp -- "$report" "$archive/report.csv"
```

每次运行使用新的私有结果目录（0700），其中只有 `report.csv` 和 `summary.json`（0600）。通过 `sudo` 运行时，目录与文件归调用用户所有，读取和归档无需再次 `sudo`。直接以 root 运行则归 root。`/tmp` 适合临时取件，需长期留存时请及时归档。

## 换成门店自己的订单

保留示例文件，按同目录 `orders.csv` 的表头和字段格式准备订单，然后指定文件：

```bash
report=$(sudo python3 -I -B examples/daily-close/run.py --orders "$HOME/门店订单/今日订单.csv") && cat -- "$report"
```

`--orders` 只改变上传内容，沙箱里的文件名始终为 `orders.csv`。自带订单的成功条件是日结程序正常退出、非空报表下载成功、沙箱删除且资源清理完成；金额和笔数应按当天业务记录核对。`summary.json` 中 `expected_csv` 为 `not_applicable`，使用默认订单并通过比对时为 `matched`。

非默认构建位置可用 `--gateway PATH`、`--client PATH`、`--bundle PATH` 和 `--image TAG` 指定。容器访问不了自动探测的 Docker bridge 网关时，用 `--bundle-host HOST` 指定容器可达的宿主地址。

## 失败时

执行失败、参考报表不匹配或资源清理失败都会返回非零退出码，不交付报表。运行器复用 [受限生命周期和清理逻辑](../../client/scripts/agent_acceptance.py)，包括有限等待、临时 SSH 身份和独立的 known_hosts。失败或收到 SIGINT/SIGTERM 时，清理流程尝试通过 Gateway 删除沙箱，并按本次随机 scope 的标签检查和回收残留容器与卷。宿主掉电或进程被强杀时，可用标准错误中的 scope 核对 Docker 标签 `io.ursi.scope`。密钥、token、订单原件和服务日志均不进入结果目录。
