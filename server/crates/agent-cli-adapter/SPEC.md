---
parent: ../../SPEC.md
depends-on:
  - ../agent-runtime/SPEC.md
  - ../domain/SPEC.md
---

# agent-cli-adapter

## 功能意图

agent-cli-adapter 是具体 agent CLI 的适配层。它实现 agent-runtime 的 `Runner` 接口：内置 mock 适配器（确定性输出，用于测试与演示）与真实 agent CLI 适配器（启动 CLI、传入提示与配置、解析输出为统一结果）。能力配置的渲染实现（模型参数、Skills 物化、MCP 配置）在本层完成。新增执行器通过实现 `Runner` 接口接入，不改动 server 与 agent-runtime。

## 关键功能与验收

### mock 适配器

确定性输出的 mock 实现，用于端到端验证调度逻辑与开发演示。

#### 验收

- mock 适配器返回预设的确定性输出，server 全链路可用 mock 跑通。

### 真实 CLI 适配器

至少一个真实 agent CLI 适配：经 channel 传输进入沙箱，启动 CLI、注入能力配置、流式回收工具轨迹与日志（经 agent-runtime 的事件回流契约上报）、解析最终输出为统一结果。

#### 验收

- 真实 CLI 适配器能在沙箱环境完成一次完整执行，产出统一结果与产物。
- 新增一个 CLI 适配器无需改动 server、agent-runtime 与 domain。

### 能力配置渲染实现

把角色能力字段渲染为具体 CLI 可消费的配置：提示词写入任务描述，模型与思考强度转为 CLI 参数，Skills 物化为技能文件，MCP 工具渲染为 CLI 的 MCP 服务配置。

#### 验收

- 给定含模型与 MCP 工具的角色，渲染后 CLI 配置包含对应参数与服务条目。
- 给定含 Skills 的角色，渲染后在执行环境中物化对应技能文件。
