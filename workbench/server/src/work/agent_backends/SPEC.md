---
parent: ../../../../../executor-platform/server/SPEC.md
references:
  - README.md
  - ../catalog/HTTP.md
  - ../../../../../docs/EXECUTOR-MCP.md
---

# Agent 后端注册与设置目录

## 功能意图

执行器平台让管理员用稳定 ID 登记本机 Agent 程序，依据平台配置包所需能力与最近一次协议检查选择后端。此规格保留在 Workbench 旧文档路径；注册、探测与绑定都由平台完成，Workbench 的服务身份无权管理后端。

## 关键功能与验收

### 启动时注册

#### 验收

- 无后端配置时，目录只含 `pi`，`configured` 为 `false`。配置 Pi 程序和全局策略后，`configured` 为 `true`，支持 `skills` 与 `tools`。
- 额外后端由 `URSI_AGENT_BACKENDS` 的私有 0600 JSON 文件登记，使用与 Pi 相同的策略和执行契约。基础能力覆盖系统指令、材料与报告。可选能力以管理员声明为准。
- 清单、程序和策略路径、文件权限、稳定 ID、能力声明按[部署配置](README.md#部署配置)校验。非法或重名 ID、`flow` 或 `pi` 冲突、无效显式后端配置均使注册失败。

### 目录、兼容性与健康检查

#### 验收

- 无包参数的 GET 只返回描述与最近检查结果。带 `configPackageId` 的 GET 使用配置包预览快照，每项增加 `compatible`；需要 Skill 或工具时，后端须声明相应能力。无效包返回解析错误。
- 每项初始状态为 `unchecked` 且 `checkedAt` 为 `null`。按 ID 检查时，在 Store 的私有 `executor-workspaces` 目录上探测 stdio 接口，支持全新 Store。检查不启动模型、不调用业务工具。
- POST 返回一项，成功为 `ready`，失败为 `failed`，`checkedAt` 为完成时的 Unix 毫秒数。未知 ID 返回 404。公开描述和结果均不含绑定路径、策略正文或子进程诊断。

### 新选择与既有绑定

#### 验收

- 注册表克隆共享本进程内的检查结果。显式选择仅接受所指定的已配置、通过检查且兼容的后端；自动选择要求恰有一个这样的候选。零个与多个候选产生不同错误。
- 按 ID 恢复既有绑定时只接受已配置的后端，`unchecked` 或 `failed` 状态不影响查找。查找与选择均只向工作模块提供 ID、程序路径和策略路径。
