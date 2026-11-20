---
parent: ../../../SPEC.md
depends-on:
  - ../catalog/SPEC.md
  - ../patches/SPEC.md
  - ../directories/SPEC.md
references:
  - ../../../../EXECUTOR-MCP.md
  - ../../../../FLOW-EXECUTOR-DESIGN.md
  - ../../../../PI-AGENT-EXECUTOR-DESIGN.md
---

# 执行器尝试

## 功能意图

让已认证的调用方用自己持有的尝试 ID 提交冻结指令、核对后端状态，并读取本次产生的文件。Workbench 负责尝试和只读制品目录，通过管理员配置的本机 stdio MCP 程序访问执行后端。

## 关键功能与验收

### 固定执行入口

#### 验收

- 启动、查询和取消均要求管理令牌。旧 Flow 请求使用 `URSI_EXECUTOR_BIN`；Agent 请求使用 `URSI_PI_EXECUTOR_BIN` 与 `URSI_PI_POLICY`，任一缺失或不是绝对路径时返回 503，不产生后端运行。
- 每次工具调用以独立进程和 `rmcp` stdio 会话运行固定的绝对路径。子进程只得到契约列出的环境变量，无需在平台 MCP 服务中登记。客户端只发送一次 `tools/call`，正常关闭 stdin 并检查退出状态，失败或超时回收进程。

### 按 ID 启动、查回与取消

#### 验收

- 调用方 PUT 小写 UUID、UTF-8 指令和可选工作包，获得对应尝试。旧 Flow 请求不带目标字段；Agent 请求带 `executorRef: {id, revision}` 或 `previewDefinition`，两者不可同时出现。同 ID 同参数重复 PUT 复用同一次运行；改动目标、指令或工作包返回 409。
- 丢失启动回执后，用原 ID GET 可核对仍在运行或已结束的后端任务。即使服务重启，GET 也不重发启动；只有调用方显式以相同参数 PUT 才可按原 ID 重发幂等启动。
- 查询、取消和重复启动只访问首次登记的运行器。非终态尝试的运行器路径或部署绑定发生变化时返回 503，不改走其他后端。已发布的制品仍可读取。
- POST 取消只作用于对应尝试；以实际后端状态确认终态。尚无终态证据时可继续 GET 查询。

### 输入与只读制品

#### 验收

- 各次尝试有独立 workspace，工作包输入放在 `inputs/`，`artifacts/` 用于输出。Agent 尝试同时写入 `root/<id>/agent-config.json`，文件权限为 `0400`，SHA-256 摘要随尝试登记。重复启动核对原文件，快照缺失或被改写时拒绝启动。公开引用对应本次 ID，不公布宿主绝对路径。
- 运行中或待核实不发布 `artifactDirectoryId`。确认终态并收集制品后，该 ID 可用于查询目录树、读取文件；新增或覆盖文件返回 409。已发布目录不包含 `inputs/` 或 Agent 配置。
- 指定修订使用目录中已发布的 Agent 快照；草稿试跑冻结本次解析结果，不占用修订号。
