# 沙箱运行环境契约

## 交付边界

镜像提供系统工具、Agent CLI、sshd、成熟监督器与 bootstrap。当前 `pi-execution` 镜像还包含未来能力所需的基础程序，但这不表示 IDE、CDP 或 noVNC 已实现或已开放。bundle 提供 session-service（含 CLI Adapter）、平台脚本、监督配置和能力清单。每种程序只有一处交付来源，监督器程序在镜像，监督配置在 bundle。

bundle 清单保留版本、内容校验值和最低镜像级别，并统一声明 `bundles`、`required_capabilities`、`services`、`endpoints`、`readiness`。`endpoints` 只含 `name`、`protocol`、`port`，不含 endpoint address、visibility 或 Gateway key。`bootstrap` `/ursi/bootstrap` 校验后装配服务，校验失败不启动业务进程。

Gateway 信任管理员注册表中的 `image -> bundles` 映射，再把注册 bundle 的能力组合成该镜像允许的端点集合。未注册镜像不开放受管端点，用户不能通过 `SandboxSpec` 添加或改变端点。端点地址和 visibility 由 Gateway bridge 在运行实例中生成，所有容器端口只经 bridge 访问。运行时具备 bundle 装配能力，在线更换是否需要停止会话由更新操作明确约束，不能覆盖正在使用的程序。

`pi-execution` 当前只提供 SSH/SFTP 与 ACP，交付入口见 [Runtime 使用说明](README.md)，执行协议见 [Agent 契约](AGENT-CONTRACT.md)。IDE、CDP、noVNC 是未来独立 bundle，不得当作当前实现。

## 对端服务

| 当前端点 | 协议与容器端口 | 资源管理方 |
|---|---|---|
| `ssh` | SSH，2222 | sshd 管连接进程，调用方控制命令 |
| `agent_session` | ACP over WebSocket，8765 | session-service 管会话和 CLI 子进程 |

IDE、浏览器调试、桌面和应用预览不是当前 `pi-execution` 端点。未来 bundle 可以声明它们的能力，但必须提供对应服务、就绪条件和明确的依赖。

bundle 只声明容器端口和协议。Gateway 根据管理员注册表与运行时状态返回逻辑端点，负责 bridge 到容器端口；地址、visibility 和公开策略不进入 bundle。所有容器端口都经 Gateway bridge，不能要求最终用户直接连接容器地址。多个通道可以共用一个端点。服务侧身份校验仍须执行。

## 就绪与停止

就绪检查覆盖管理员注册并启用的 bundle 所声明的必需服务。当前 `ssh`/SFTP 就绪验证实际连接能力，`agent_session` 就绪验证 session-service 可接收请求，单一 TCP 端口开放不代表所有服务就绪。

监督器只负责常驻服务保活，session-service 管 agent 执行进程。连接断开、会话取消、任务失败、服务退出分别报告，服务恢复不自动重放任务。沙箱停止按监督配置传递信号并回收子进程。

## 工作区与凭据

Gateway 挂载根为 `/ursi/workspace`。调用方负责组织挂载根下的业务目录、输入与产物。独立客户端可直接在挂载根下准备 Git 项目，session-service 校验目录归属并排除私有状态目录。工作区保留策略由 Gateway 管理的存储资源落实，bundle 装配不清空工作区。

凭据通过受控运行时注入，按 CLI 或服务需要采用环境变量或限权临时文件。Runtime 内部 token、SSH key 和 probe key 是服务内部防线，用于服务间鉴权、SSH 登录和健康检查，不要求最终用户为每个端点逐一输入。凭据不写入镜像、bundle 或普通元数据日志，临时凭据随会话或沙箱释放清理。读取、传输和观测路径均执行访问范围校验与敏感信息过滤。
