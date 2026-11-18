# 工作管理两阶段 HTTP 验收

[`work_e2e.py`](work_e2e.py) 通过带 Bearer 认证的 HTTP 请求操作真实 `ursi-server`。每个阶段使用独立的临时数据目录、工作区、令牌和回环端口；Agent 阶段的两次 Server 启动复用同一数据目录。脚本退出时清理临时文件与服务。

## 运行

从仓库根目录执行。需要 Linux、Python 3、可构建本仓库的 Rust 工具链以及 Node.js 22.19+。Agent 阶段需要已安装的真实 Pi CLI，支持 [Agent 执行参数](../src/work/execute/API.md)。Flow 阶段需要支持 `run.startPinned` 的 daemon 和对应的 Rust CLI。

```sh
# 构建产物已就绪时，直接执行最后一行。
cargo build --locked -p ursi-server
(cd flow-runtime && npm ci && npm run build)
cargo build --locked --manifest-path flow-runtime/client/Cargo.toml
python3 server/tests/work_e2e.py
```

使用其他位置的产物或单独复跑一个阶段：

```sh
python3 server/tests/work_e2e.py --stage agent --server /path/to/ursi-server --pi /path/to/pi
python3 server/tests/work_e2e.py --stage flow --server /path/to/ursi-server \
  --daemon /path/to/dist/machine/daemon.js --cli /path/to/ursi-flow
```

默认路径为 `target/debug/ursi-server`、`PATH` 中的 `pi`、`flow-runtime/dist/machine/daemon.js` 和 `flow-runtime/client/target/debug/ursi-flow`。脚本只启动指定产物，不触发构建。默认运行两个测试，`Ran 2 tests`、`OK` 且退出码为 0 表示两阶段通过。单阶段结果只覆盖所选阶段。缺少依赖或断言失败时退出码非零。

## 阶段一：关闭 Flow，同包办理两单

`URSI_FLOW_ENABLED=0`，`URSI_FLOWD_BIN` 指向不存在的文件。Server 必须正常响应且不创建 daemon socket。`URSI_AGENT_BIN` 指向真实 Pi CLI。**模型是模拟的**：脚本为 Pi 生成临时 `HOME`、`models.json` 和 `settings.json`，只为本地测试端点配置占位密钥。Server 子进程环境采用白名单，不继承操作者的模型凭据。

1. 通过 HTTP 发布提示词、Agent 执行器和工作包的第 1 版，按同一包版本创建两张单，分别填写不同的材料编号并开始办理。
2. 发布三者的第 2 版，再执行两张旧单。回环端点须收到两次 Pi 的流式模型请求，每次用户消息都含动作、原 SOP、第一版提示词和对应编号，不含新版提示词或另一张单的编号。端点固定返回 `SIMULATED-MODEL: fixed report`，两条成功尝试都须读到该文本，业务状态仍为 `working`。
3. 分别以本单编号及执行输出生成同名 `report.txt`，关联各自的尝试。一单通过，一单附意见退回。重启 Server 后，通过 HTTP 对照两单详情、状态筛选清单、接受版本、退回意见及文件原文。模型端点仍应只收到两次请求。

## 阶段二：开启 Flow，验证固定修订

`URSI_FLOW_ENABLED=1`。Server 通过一个只负责 `exec node` 的启动器运行编译后的真实 daemon。独立 `ursi-flow` CLI 通过本阶段的私有 socket 查询历史。

1. 通过 v1 发布带命令节点的 Flow。发布绑定该目录修订的 v2 执行器，让 `alpha` 和 `beta` 两包共用它，各派一单。先执行 `alpha`，节点把工作项输入追加到工作区的 `effects` 并输出该输入。
2. 使用 v2 的尝试 ID 读取 v1 运行历史，再用 CLI 查询同一 ID。两份历史须完整相等，且包含已完成的运行、预期修订、一个节点和对应输入的命令输出。文件中须恰有一行。
3. 在 `beta` 已派工、尚未启动动作时，通过 v1 更新 Flow 目录，并发布新的 v2 执行器与包版本。旧单启动须返回 HTTP 409，保留一条绑定旧修订的失败尝试。v1 查询该尝试 ID 的历史须返回 404，运行列表仍只有 `alpha`，其历史和 `effects` 的内容均保持原样。
