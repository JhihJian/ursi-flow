---
references:
  - workbench/README.md
  - flow-runtime/docs/flow-spec.md
---

# ursi-flow

## 功能意图

ursi-flow 把可重复的工作过程写成以 `FLOW.md` 为入口的包。用户通过 Web、HTTP API 或本机 CLI 维护流程包、启动和停止运行、查看节点结果。Flow Runtime 校验并执行包，根据节点报告的结果选择下一步，保存每次运行的历史。Server v2 的 HTTP 工作清单以已发布的工作包派工，将动作交给 Agent 或固定修订的 Flow 执行，并独立记录交付和验收结果。

## 模块地图

| 模块 | 职责 |
| --- | --- |
| [flow-runtime](flow-runtime/SPEC.md) | Node.js 引擎与本地执行器。`ursi-flowd` 管理包修订、执行配置、后台运行与历史；`ursi-flow-local` 用于单次本地执行。 |
| [flow-runtime/client](flow-runtime/client/SPEC.md) | Rust `FlowClient` 与 `ursi-flow` CLI，通过 Unix socket 访问 daemon。 |
| [flow-runtime/web](flow-runtime/web/SPEC.md) | 独立 Flow 控制台。静态包加同源桥，完成建包、运行、历史与配置闭环。 |
| [workbench](workbench/SPEC.md) | 工作台项目。Web 通过 Server 的同源 API 办理工作项；启用 Flow 时可管理流程包、运行与配置。 |
| [ursi-sandbox](ursi-sandbox/SPEC.md) | 独立交付的沙箱 Gateway、Runtime 和 Client。本地 Flow 执行不依赖该工作区。 |

## 关键功能与验收

### 按工作包办理与交付

#### 验收

- `/api/v2` 按发布版本固定包、资源及执行器。同一包派出的两单分别保存输入、尝试、交付文本和验收意见，重启后仍可按单查回。关闭 Flow 时，配置了本地 Pi 的 Agent 动作仍可执行。
- Flow 动作按固定目录修订启动（pinned）；修订已变更时在运行节点前返回 409。成功启动后，CLI 可按尝试 ID 查询同一份运行历史。
- 可选来源是管理员配置的本地 JSON 导出文件，可按固定动作派工。预配 ACP 沙箱适配器仅有模拟客户端的契约测试，Server 没有 PTY、浏览器或通用文件管理接口。

### 校验与发布流程包

#### 验收

- 校验含 `FLOW.md` 及其引用文件的草稿后，目录中的已发布包不变。非法更新保留原修订。
- 按预期修订更新成功后，新运行使用新修订。提交过期修订返回冲突。

### 不依赖工作台办理 Flow

#### 验收

- 独立控制台只取 `flow-runtime/web` 即可构建并发布静态包，用同源 `/api/v1` 接口完成建包、校验、运行、查看证据、停止与配置修改。
- 启动运行必须先确定工作目录：daemon 运行配置里保存工作区根目录，未指定目录的运行在 `<工作区根目录>/<Run ID>` 新建目录执行；工作区未配置时拒绝启动并提示去配置。
- 控制台请求的形状与工作台的 Flow 接口一致，嵌入工作台时不需要改写页面逻辑；Runtime 未启动时显示错误，不退回演示数据。
- 运行详情按固定修订画流转图并标出当前节点，节点执行记录直接展示 Pi SDK 会话轨迹；轨迹来自 Runtime 按节点执行保存的会话切片，命令节点与旧运行降级为命令证据或说明。路由记录把节点开始、节点结束与路由判定按时间排成一条序列，可逐条查看入参、提交结果与去向。

### 在受信工作区执行与查询

#### 验收

- 启用 Flow 时，v1 HTTP 从已发布的包发起运行，只接受管理员映射的 `default` 工作区。命令在该目录执行，运行历史可查到节点结果与命令输出。
- 通过 HTTP 启动的运行可由连接同一 daemon 的 CLI 查询和停止；删除流程包或正常重启服务后，已完成运行的历史仍可读取。
- Web 通过同源 API 读取和修改运行配置，页面不做访问令牌验证；服务只接受 IP 字面量、`localhost` 或登记域名作为 Host，写请求必须是同源页面发起，否则返回 403 且配置不变。
