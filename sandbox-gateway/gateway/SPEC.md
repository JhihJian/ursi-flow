---
parent: ../../SPEC.md
references:
  - ./CONTRACT.md
---

# sandbox-gateway/gateway

## 功能意图

sandbox-gateway/gateway 是沙箱控制面，一个独立进程。它管理沙箱容器资源：创建、启动、停止、删除、重建、状态查询、元数据持久化、启动时资源对账、端口地址返回，并提供可选的网关 TCP/WebSocket 传输（tunnel）与 public/internal 端口隔离。kernel 经版本化 REST 契约调用 gateway，二者不共享代码。gateway 自带存储与恢复，不依赖 kernel 的任何模块，可独立部署。

参考 grasp 的 sandbox-gateway/gateway 做行为对齐（parity）：HTTP 路径、状态码、错误体结构、生命周期状态迁移语义与 grasp v1 接口一致；v2 传输按 ursi-tcp-v1 帧协议对齐。框架（gin vs axum）与语言机制不做对齐。

功能拆为三个模块（对应 grasp 的组织）：

- `lifecycle`：沙箱服务与状态存储：创建（异步受理）、就绪探测、状态迁移、重建、元数据持久化、启动时资源对账、删除意图重试；含驱动抽象 `Driver` 与 fake/docker 实现、元数据模型（models）
- `tunnel`：可选的网关 TCP/WebSocket 传输：经 gateway 鉴权后把客户端字节流中继到沙箱内指定端口（ursi-tcp-v1 帧协议），client 不直接持有沙箱地址
- `gateway-api`：REST 路由、Bearer API key 鉴权（本地匿名豁免可配置）、错误映射、capabilities/info 描述接口

## 关键功能与验收

### 生命周期接口（gateway-api + lifecycle）

暴露沙箱生命周期接口：创建、查询（单个/列表，支持标签过滤）、启动、停止、删除、重建（reinstall，可保数据）、状态、日志、端口地址（Host/PublishPort）。创建为异步受理（受理后状态经 pulling/creating 到 running）；非存在沙箱返回 404；非法状态迁移返回 409；驱动不支持的能力返回 501。

#### 验收

- 按 grasp v1 契约提交创建请求，返回受理响应，最终可查询到 running 状态与端点。
- 查询不存在的沙箱返回 404；对停止中的沙箱重复停止返回 409；驱动未实现的能力返回 501。
- 重建（reinstall）默认保留数据卷重建工作负载；不保数据时先删后建。共享宿主挂载的配置不被删除。

### 端口隔离与地址返回（lifecycle + gateway-api）

端口分为 public 与 internal 两级：public 端口由驱动发布到宿主（bindIP:ephemeral），地址经查询接口返回给客户端；internal 端口不发布到宿主，仅在容器网络上可达，经 tunnel 或容器内地址访问。CDP/noVNC 类通道端口属于 internal。

#### 验收

- 创建规格中的 public 端口在宿主发布并出现在返回的端点表；internal 端口不出现在宿主发布列表。
- internal 端口经 tunnel 可达；直接请求宿主对应端口不可达。

### 驱动抽象（lifecycle/driver）

以驱动接口抽象沙箱实现，驱动负责把统一的 Sandbox Spec 翻译成具体基础设施操作：docker 翻译为容器 create/start/stop/remove 与端口发布；Kubernetes 翻译为 Pod/Service/PVC/LoadBalancer；E2B 使用预配置模板与快照恢复。接口只含生命周期与端点暴露，数据面不属于驱动接口。提供 fake 驱动（内存实现，确定性状态迁移，记录调用输入供断言，默认编译）与 docker 驱动（feature 隔离编译）。一个 gateway 实例启动时按配置选择唯一驱动。

#### 验收

- fake 驱动下创建的沙箱可查询、启动、停止、删除、重建，状态迁移确定性；fake 记录最近一次创建规格供契约测试断言。
- docker 驱动实现同一接口；切换驱动不改变 REST 契约。
- k8s/E2B 驱动留接口不留实现。

### 元数据存储与恢复对账（lifecycle/store + service）

沙箱元数据持久化到 SQLite（WAL + busy_timeout）：状态、创建规格（冻结存储，恢复不依赖进程默认值）、端点、标签、错误信息。状态迁移使用 from-status 条件更新（CAS），拒绝并发脏写。gateway 重启后对存量沙箱执行对账：存储记录与驱动实际状态不一致时以驱动为准修正；未完成的删除意图被续做；对账保留已停止、启动中与暂时无法查询的沙箱，仅当驱动明确报告资源不存在时才清理记录。

#### 验收

- 重复启动 gateway 不产生重复记录，迁移幂等。
- 并发状态迁移不丢失更新；from-status 不匹配的更新被拒绝。
- 重启后，运行中沙箱被重新对账；带删除意图的沙箱被继续清理；查询错误不导致记录被删。

### 网关传输 tunnel（tunnel + gateway-api）

可选的 TCP/WebSocket 传输：客户端经 gateway 鉴权后，按「沙箱 ID + 客户端口」升级 WebSocket（ursi-tcp-v1），gateway 校验沙箱记录与驱动实际状态后解析当前端点并中继字节流。不提供任意 host/URL 参数；升级前目标不可达返回 502；未知沙箱或端口返回 404。传输鉴权与控制面鉴权独立配置：未配置 API key 时传输面禁用（503）。二进制帧承载有序 TCP 字节流，帧上限与 eof 语义按 ursi-tcp-v1。

#### 验收

- 经 tunnel 连接沙箱内 internal 端口的服务，字节双向有序传输，半关闭（eof）语义正确。
- 未知沙箱/端口返回 404；不可达返回 502（升级前）；错误子协议返回 400。
- 未配置传输 API key 时，传输请求返回 503；配置后凭 key 可用。

### 沙箱镜像与 bundle 供应（lifecycle + gateway-api）

沙箱镜像与 runtime bundle 由 sandbox-gateway/runtime 定义（镜像环境与注入沙箱的服务配置）。gateway 创建沙箱时按请求的镜像规格供应容器并下发 bundle 引用；镜像版本标记不符时创建失败并提示重建镜像。

#### 验收

- fake 驱动的契约测试锁定镜像与环境变量透传语义。
- 镜像版本标记低于 bundle 要求时，创建被拒绝且错误可区分。

## 边界

首版不含：preview 路径代理、快照暂停恢复（snapshot pause）、孤儿 GC 的完整 parity（保留删除意图重试）、Kubernetes/E2B 驱动实现、runtime bundle 热更新（bundle 随创建下发）。
