# Server 与 Flow Runtime

本页描述 v1 的 Flow 管理入口。独立工作清单、包与定义的数据归属见 [Server v2 设计](DESIGN-v2.md)。

`ursi-server` 管理 HTTP 入口和本机 daemon 的生命周期。`ursi-flowd` 是包目录、运行配置、活动任务与历史的唯一管理者。HTTP 和本机 CLI 共用 Rust `FlowClient` 协议，因此同一运行 ID 经两个入口查询时指向同一条记录。

## 一次运行的请求路径

1. Web 向 `/api/v1/flows/{id}/runs` 提交包 ID、变量和工作区别名。`transport` 检查 Bearer 令牌与请求形状，再调用 `FlowService`。
2. `flow` 将 `default` 映射为管理员配置的工作目录，保留调用方的运行 ID，省略时生成 ID。同步 SDK 调用在有并发上限的阻塞任务中执行，等待名额的请求不占用阻塞线程。
3. `FlowClient` 通过本地 Unix socket 提交请求。daemon 登记所用包修订和运行配置，调度执行器并保存节点记录。HTTP 启动成功表示运行已登记，执行结果通过运行详情和历史查询。

发布包、比较预期修订及更新配置也在 daemon 内完成。HTTP 返回 Runtime 的 JSON 结果；参数错误、修订冲突、并发已满和传输失败映射为不同的 HTTP 状态，错误正文不包含私有路径或凭据。

## 进程所有权

`app` 用 `URSI_DATA_DIR/flow-runtime/` 作为子进程的 `URSI_FLOW_HOME`。该目录仅服务账户可访问，持久数据跨 Server 启停保留。`runtime.sock` 只用于通信；进程所有权来自启动时保留的子进程句柄。发现已有 socket 时，Server 报错并保留现场，不连接、覆盖或关闭其他实例。

Server 启动自己的 daemon，确认子进程和 socket 就绪后开放 HTTP。后续启动步骤失败时，回收已启动的子进程。收到 `SIGTERM` 或 `SIGINT` 时停止受理请求，终止并等待该子进程退出，由 daemon 停止受管运行。

## 访问边界

HTTP 只暴露受鉴权的管理 API，不提供 Web 静态资源。Web 独立提供页面，生产环境可通过反向代理将页面和 API 放在同一来源。工作目录由部署者选择，但其中的流程命令仍以服务账户权限执行。API token 应仅发给有权在该账户下运行受信包的操作者。本机 CLI 依靠操作系统的私有目录权限访问同一 socket。

部署选项与启动命令见 [使用说明](README.md)，路由和错误映射见 [HTTP 规格](src/transport/SPEC.md)。
