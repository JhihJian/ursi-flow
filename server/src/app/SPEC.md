---
parent: ../../SPEC.md
depends-on:
  - ../flow/SPEC.md
  - ../transport/SPEC.md
  - ../../../flow-runtime/client/SPEC.md
references:
  - ../../DESIGN.md
---

# Server 应用装配

## 功能意图

将部署者指定的 API 身份、数据目录和工作区装配成可用的 HTTP 服务。`app` 持有 daemon 子进程的句柄，向 Flow 用例注入连接该进程的 `FlowClient`，向 HTTP 路由注入用例、认证和静态目录配置。

## 关键功能与验收

### 配置与就绪

#### 验收

- `URSI_API_TOKEN` 必填且非空。仅提供令牌时，使用 `0.0.0.0:8080`、数据根目录 `data`、`PATH` 中的 `ursi-flowd` 和当前工作目录，静态资源默认关闭。
- `URSI_LISTEN_ADDR`、`URSI_DATA_DIR`、`URSI_FLOWD_BIN`、`URSI_WORKSPACE_DIR` 和可选的 `URSI_STATIC_ROOT` 分别覆盖上述设置。HTTP 使用 `default` 指代配置的工作区。
- Server 为子进程准备私有的 `<数据目录>/flow-runtime/` 并设置其 `URSI_FLOW_HOME`。启动 daemon 后通过 `runtime.sock` 检查就绪，再提供 HTTP 服务。
- 缺少令牌、地址无效、daemon 无法执行或就绪失败时不报告服务可用。诊断不输出令牌。

### 独占与关闭

#### 验收

- 启动前已有 `runtime.sock` 时拒绝启动，不收养已有 daemon，不删除或替换 socket。
- 子进程已启动但服务装配失败时，回收本次启动的进程。收到 `SIGTERM` 或 `SIGINT` 时停止 HTTP 并等待自己的 daemon 退出，正常退出不遗留 socket 或受管命令。
- 再次启动时使用新的 daemon 进程，沿用原数据目录可以读回已保存的配置、包和历史。
