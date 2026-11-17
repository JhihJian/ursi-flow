---
parent: ../SPEC.md
depends-on:
  - crates/domain/SPEC.md
  - crates/agent-runtime/SPEC.md
  - crates/channel/SPEC.md
  - crates/mcp-server/SPEC.md
references:
  - DESIGN.md
  - ../sandbox-gateway/gateway/CONTRACT.md
---

# server

## 功能意图

server 是 ursi-flow 的主服务，以一个 Rust crate 提供流程与角色管理、可恢复的运行执行、人工审批、产物管理和业务接入。内部按业务域及状态所有权组织，模块经公开接口协作；各业务域可使用真实本域存储与外部接口替身独立交付，真实执行链路通过联合验收确认。

`server/src` 承载主服务内部模块，`server/crates` 保持独立库布局。Channel 管连接，Agent Runtime 管会话控制，真实 CLI Adapter 在沙箱 session-service 内执行。Gateway 拥有沙箱资源生命周期。

## 模块地图

| 模块 | 职责与规格 |
|---|---|
| workflows | [流程定义、结构校验和角色引用](src/workflows/SPEC.md) |
| roles | [角色配置、Skills 文件、MCP 配置及引用约束](src/roles/SPEC.md) |
| runs | [快照、运行状态、engine、审批、恢复和事件](src/runs/SPEC.md) |
| artifacts | [产物内容、元数据、执行归属和契约检查](src/artifacts/SPEC.md) |
| sandboxes | [平台资源关联、Gateway 请求和连接接入](src/sandboxes/SPEC.md) |
| connections | [模型连接、凭据引用和配置解析](src/connections/SPEC.md) |
| storage | [共享数据库、迁移、事务与内容存储基础能力](src/storage/SPEC.md) |
| transport | [HTTP、SSE/WS、MCP 与静态页面接入](src/transport/SPEC.md) |
| app | [配置、依赖组装、启动与关闭](src/app/SPEC.md) |

engine 是 runs 的内部实现，审批与事件遵循同一状态提交路径。各业务域拥有本域 repository，storage 提供可共用的事务上下文。依赖关系、界面映射与独立验收矩阵见 [模块设计](DESIGN.md)。

## 关键功能与验收

### 配置管理与运行实例化

workflows 管理流程，roles 管理完整角色配置，connections 管理模型连接与凭据引用。runs 在一致事务中读取配置并冻结运行快照，后续调度使用快照。

#### 验收

- 各配置模块分别用临时数据库和依赖替身验证完整管理用例及错误分支。
- 联合 workflows、roles、connections、storage，在并发保存引用与删除被引用配置时拒绝冲突操作，持久化数据没有悬空引用。
- 联合 runs 与配置域验证创建后的流程、角色、模型连接和技能内容修改不改变旧运行快照，新运行读取新配置。
- 缺失资源或快照保存失败时不产生可启动的半成品运行，快照及接口响应不包含凭据明文。

### 运行、审批与恢复

runs 统一管理节点调度、重试、审批返工、取消、租约和崩溃恢复。首版按 DAG 依赖顺序执行，依赖满足后才启动下游。

#### 验收

- 使用 mock 执行接口可独立跑通创建、顺序执行、等待审批、放行、打回、失败重试和取消。
- 打回仅允许传递祖先，重试与返工次数受到限制，非法操作返回错误且不改变状态。
- 真实 SQLite 重开后可接管租约到期运行，过期代数提交被拒绝，结果未知的任务先核实再决定后续操作。

### 状态与事件一致性

runs 在同一事务中保存状态和对应有序事件，提交成功后广播。transport 使用持久事件进行历史重放、断线续传和通知滞后补读。

#### 验收

- 联合 runs、storage 注入提交失败，状态与事件同时回滚。
- 提交成功后广播前崩溃，重启后状态和事件均可查询。
- 联合 transport，在订阅交界、重复通知、慢消费者和断线重连场景下，事件按游标输出且不丢不重。

### 执行环境与产物交付

sandboxes 接入 Gateway 与 Channel，runs 调用 Agent Runtime 控制沙箱会话，artifacts 保存回收内容和执行归属。运行结果与资源清理结果分别记录。

#### 验收

- 各模块通过接口替身分别验证就绪、执行调用、产物校验与释放请求的成功和故障路径。
- 联合真实 Gateway、Channel、Agent Runtime 和沙箱 CLI，验证提示词、模型、Skills 与 MCP 配置实际生效，任务产物可回收并读取。
- 返工后旧尝试的迟到产物不能成为当前有效输出，必需产物缺失时下游不执行。
- 释放失败时可查询、可重试，资源未确认释放前不标记释放成功。

### 应用接入与交付

transport 暴露业务协议，app 组装服务和后台任务，web 通过同一接口使用业务能力。程序支持内嵌页面资源与配置目录回退。

#### 验收

- transport 用业务替身独立验证参数、错误映射、身份上下文与流式协议；app 用组件替身独立验证装配和启动关闭失败路径。
- 联合真实 SQLite、HTTP 和 mock 执行接口，完成角色配置、流程引用、启动运行、审批和查询产物的应用闭环。
- 重启后配置与运行记录仍可查询，服务启动失败不报告就绪，关闭后监听和后台句柄释放。
- 真实执行链路和页面操作分别提供联合验收证据，不以接口替身通过替代。
