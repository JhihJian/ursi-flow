---
parent: ../SPEC.md
references:
  - ./CONTRACT.md
---

# sandbox-gateway

## 功能意图

gateway 是沙箱控制面，一个独立进程。它管理沙箱容器的生命周期：受理创建、探测就绪、暴露端点、驱动底层资源（容器）、持久化状态并在重启后恢复对账。kernel 经版本化 REST 契约调用 gateway，二者不共享代码。gateway 自带存储与恢复，不依赖 kernel 的任何模块，未来可独立部署与扩展驱动。

参考 grasp 的 sandbox-gateway/gateway 做行为对齐（parity）：HTTP 路径、状态码、错误体结构、生命周期状态迁移语义与 grasp v1 控制面一致。框架（gin vs axum）与语言机制不做对齐。

## 关键功能与验收

### 生命周期 REST 接口

暴露沙箱生命周期接口：创建、查询（单个/列表，支持标签过滤）、启动、停止、删除、状态、日志。创建为异步受理（返回后状态经 creating 到 running）；非存在沙箱返回 404；非法状态迁移返回 409；驱动不支持的能力返回 501。所有接口经 API key 鉴权（与 kernel 的共享密钥），匿名本地网关可配置豁免。

#### 验收

- 按 grasp v1 契约提交创建请求，返回受理响应，最终可查询到 running 状态与端点。
- 查询不存在的沙箱返回 404；对停止中的沙箱重复停止返回 409。
- 缺失或错误 API key 的请求被拒绝。

### 驱动抽象

以驱动接口抽象沙箱实现：接口只含生命周期与端点暴露，数据面（exec、文件、日志流）不属于驱动接口。提供 fake 驱动（内存实现，确定性状态迁移，记录调用输入供断言，默认编译）与 docker 驱动（feature 隔离编译）。一个 gateway 实例启动时按配置选择唯一驱动。

#### 验收

- fake 驱动下创建的沙箱可查询、启动、停止、删除，状态迁移确定性。
- fake 驱动记录最近一次创建规格，供契约测试断言 env 与端口透传。
- docker 驱动实现同一接口；切换驱动不改变 REST 契约。

### 状态存储与恢复

沙箱记录持久化到 SQLite（WAL + busy_timeout）。状态迁移使用 from-status 条件更新（CAS），拒绝并发脏写；创建规格在创建时冻结存储，重启后的恢复对账不依赖 gateway 进程内存与默认配置。gateway 重启后对存量沙箱执行对账：存储记录与驱动实际状态不一致时，以驱动为准修正，并继续未完成的删除意图。

#### 验收

- 重复启动 gateway 不产生重复记录，迁移幂等。
- 并发状态迁移不丢失更新；from-status 不匹配的更新被拒绝。
- 重启后，运行中沙箱被重新对账；带删除意图的沙箱被继续清理。

### 沙箱镜像供应

沙箱镜像与 runtime bundle 由 sandbox-runtime 目录定义（镜像环境与注入沙箱的服务配置，见其 CONTRACT）。gateway 创建沙箱时按请求的镜像规格供应容器并下发 bundle。

#### 验收

- fake 驱动的契约测试锁定镜像与环境变量透传语义。
- docker 驱动使用 sandbox-image 构建的镜像创建的沙箱内，bootstrap 入口可执行。

## 边界

首版不含（对齐 grasp 的裁剪）：runtime bundle 热更新、reinstall、preview 路径代理、v2 connect TCP/WebSocket 隧道、快照暂停恢复、孤儿 GC 的完整 parity、Kubernetes/E2B 驱动。其中「运行面端点暴露」（kernel 直连沙箱的地址发布）属于 REST 契约的一部分，随生命周期接口提供。
