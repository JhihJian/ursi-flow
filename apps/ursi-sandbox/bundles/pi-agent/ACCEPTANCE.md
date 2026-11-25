# 独立沙箱 Agent 执行验收

2026-11-17，`pi-execution` 环境通过真实模型端到端验收。独立客户端驱动 Gateway、SSH/SFTP 和 ACP，完成代码修复、回归测试、取消回收、会话隔离、工作区保留和资源删除。运行过程无需启动 server、FSM 或 Web。

## 交付与环境

三个工作包在独立 Git worktree 中并行实现，统一契约后合并到集成分支。

| 工作包 | 内容 | 主要提交 |
| --- | --- | --- |
| 镜像与监督 | 正式 Pi 镜像、安全 bootstrap、bundle、SSH/SFTP、有限恢复 | `0290439` |
| Pi 与会话服务 | Pi RPC、ACP WebSocket、事件、取消、状态恢复 | `9b3664b`、`3848007` |
| 客户端与验收 | 独立 CLI、真实验收脚本、跨 UID 进程核验 | `c68368d`、`fc5abfa` |
| 集成配置 | 管理员 runtime_profile 白名单、只读配置挂载和固定能力集 | `b20b7e1` |

真实验收代码基线为 `ffe6793`。环境使用本机 Linux/Docker、Ubuntu 24.04、Node 24.13.1、Pi 1.5.0、Git 与 supervisord。模型来自验收专用的最小 provider 配置，凭据保存在仓库外私有目录。Agent 以 UID/GID 1000 运行。

- 镜像：`ursi-runtime-pi:local`，ID `sha256:62cbb9b1cffb4a35562b5797cc46f48a5616cda315b016f1f29b00ccc8514419`。
- 验收 bundle SHA256：`1515f0c1bbd6cef7bfae0939c1a45f82d059d5784076ca7f63701666569f115c`。
- 沙箱：`e3bce0fba383439f9a10a9b9aa38f885`。
- 随机 scope：`ursi-agent-8e34dd364020f8cb74dd`。

## 真实行为与证据

| 判据 | 验证方式 | 结果 |
| --- | --- | --- |
| 正式环境可用 | Gateway 创建镜像与 bundle，SSH/SFTP 登录并准备 Git 仓库 | 通过 |
| 真实 Agent 修改 | ACP 驱动 Pi 修复 `calculator.py` 并补充 `test_calculator.py` | 通过 |
| 结果独立验证 | SSH 运行测试与固定断言，检查 Git diff，SFTP 读取产物 | 通过 |
| 回归测试有效 | 重新注入原始函数缺陷，确认新增测试失败 | 通过 |
| 取消回收 | 在长工具存活时取消，等待 cancelled，确认监督器和工具父子 PID、标记进程消失 | 通过 |
| 另一会话可用 | 取消后另一会话继续完成真实 prompt | 通过 |
| 工作区保留 | stop/start 后核对文件摘要，再次运行测试 | 通过 |
| 删除清理 | Gateway 查询为 404，scope 下容器和卷数量为零 | 通过 |

归档的[脱敏 JSON 证据](evidence/pi-execution-20261117.json)包含各阶段结果、产物和 diff 摘要、事件计数及进程回收证据。记录中的 `cli_pid:60` 指会话监督器 PID，工具父子 PID 为 198、199，均为当时容器内的 PID。

源日志位于 `/tmp/ursi-agent-execution-2.log`，源证据位于 `/tmp/ursi-agent-execution-evidence-2.json`。临时服务、模型配置、SSH 密钥、验收容器和卷已清理。正式镜像和 bundle 构建产物保留供复用。

## 定向测试与复审

各工作包分别运行相关测试，集成阶段按具体改动复验。

- 镜像：14 项 bootstrap 测试、3 项清理故障测试，确定性 bundle 与 SHA256 检查。真实镜像 smoke 验证 SSH exec/PTY/SFTP、权限隔离、离线重启、工作区保留及有限恢复。
- 会话修复：7 个定向用例验证监督器异常、清理回执、cwd 替换、正常与立即取消、运行中关闭、断线重启。新增异常退出和 cwd 用例同时以普通用户和 root 执行。
- 客户端修复：13 项 Python 测试与 8 项 ACP/CLI 测试验证跨 UID 进程核验、残留检测、失败诊断和协议行为。
- Gateway：新增 profile 校验定向测试通过，拒绝未知名称、非法结构和非私有配置目录。
- 四个交付 crate 的定向 Clippy `-D warnings`、格式检查与差异检查通过。合并到主分支后，`spec_validate` 校验全部模块规格通过。
- 独立复审关闭取消假成功、cwd 替换和白名单变更阻断数据库重启问题，未发现新的 P1/P2。

真实验收后，提交 `325e1ca` 将服务监听环境变量统一为镜像已提供的 `URSI_SESSION_BIND`。随机端口启动、鉴权和工作区边界的定向用例通过。主分支同期业务模块合并后，对四个交付 crate 执行了离线编译检查。完整模型验收对应上述固定基线和 bundle 摘要。

收尾构建产物位于集成源工作树的 `target/debug/`，最终 bundle 源路径为 `/tmp/ursi-agent-delivery-bundle/runtime-bundle.tar.gz`，SHA256 为 `e36aabc5ef9ee99eb85a2da8eca19b0a2272b8eb11c7c5675e733ed8cab60d6e`。该 bundle 包含监听变量统一调整，其启动行为由上述定向用例验证。

## 使用范围

本次交付覆盖 Pi、SSH/SFTP、ACP 和本机 Docker。IDE、CDP、noVNC 按环境能力单独扩展。ACP 采用已声明的子集与 `_ursi` 扩展，当前支持文本 prompt 和空 MCP 配置。

正常取消成功意味着已确认所属进程回收。监督器被 SIGKILL/OOM 终止等异常会持久化清理失败，并返回 interrupted；此时停止或删除外层沙箱可清除遗留工具。单个沙箱内会话共享 agent 用户，跨信任主体隔离使用不同沙箱。

复现入口与构建命令见 [Runtime 使用说明](README.md)，验收输入和超时配置见 [客户端说明](../../client/README.md)。
