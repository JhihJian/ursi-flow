# 固定执行器修订的跨进程验收

从仓库根目录运行 `./executor-platform/acceptance/run.sh`。需要 Linux、Rust 1.88+、Python 3 和 Node.js 22.19+，以及已安装的 `flow-runtime/node_modules`。脚本从当前源码构建平台、Workbench 服务端与 Flow daemon。构建缓存位于 `.build/`，每次测试新建独立数据目录并在结束时清理。

两个用例共享平台通过 HTTP 发布的 `reviewer@1`。随后发布的 `reviewer@2` 使用不同提示词。只有模型后端替换为本地 stdio MCP 程序，制品仍由平台收集，断言均通过服务 API 读取。

- `test_direct`：通过 Workbench 创建工作包，将随机标记写入 `material.txt`，指定旧修订执行。通过 Workbench 的制品目录读回标记、旧提示词和尝试 ID。
- `test_flow`：通过 Workbench 创建和启动审核 Flow，提交同一修订。后端从节点指令取得本次标记，写入 `flow-outcome.json`。检查运行历史中的回执、实际选中的“退回”边和后续执行的“登记退回”节点，并核对该节点委派尝试的制品。

平台管理令牌只用于准备数据。Workbench 和 Runtime 各使用独立的消费者令牌，测试也验证双方读取对方尝试均返回 404。Workbench 客户端另用独立令牌。`URSI_FLOWD_BIN` 指向本次测试的私有启动脚本，它通过 `exec` 启动真实 daemon。Workbench 启动子进程时传入 Runtime 专属令牌。
