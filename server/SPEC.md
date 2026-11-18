---
parent: ../SPEC.md
depends-on:
  - ../flow-runtime/client/SPEC.md
references:
  - DESIGN.md
  - README.md
---

# ursi-server

## 功能意图

为 Web 和 HTTP 客户端提供受认证的 Flow 管理入口。Server 管理本机 `ursi-flowd` 子进程，通过 Rust SDK 调用它；包修订、运行配置、执行和历史由 Flow Runtime 持有。

| 模块 | 职责 |
| --- | --- |
| [app](src/app/SPEC.md) | 读取部署配置、启动和回收 daemon、装配 HTTP 服务。 |
| [flow](src/flow/SPEC.md) | 解析工作区别名，用有界的阻塞任务调用 `FlowClient`。 |
| [transport](src/transport/SPEC.md) | Bearer 鉴权、HTTP 路由、错误映射及可选静态资源。 |

## 关键功能与验收

### HTTP 管理与页面入口

#### 验收

- `/api/v1` 提供包校验与增删查改、启动与停止运行、运行详情与历史、运行配置读写。CLI 连接同一 socket 时能读回 HTTP 提交的更改。
- 未经认证的 API 请求返回 401。运行请求只接受 `default` 工作区，目录由部署者配置。
- 可选静态目录提供无需认证的页面资源与前端深链。未知 API 路由不回退到页面。

### 子进程与持久数据

#### 验收

- 缺少 `URSI_API_TOKEN` 时启动失败。Server 自动启动配置的 daemon，确认可以通过私有 socket 调用后才对外服务；已有 socket 时拒绝启动。
- 收到 `SIGTERM` 或 `SIGINT` 后，HTTP 监听和本实例启动的 daemon 均退出。以同一数据目录重启，可查到已发布包和已保存的运行历史。
