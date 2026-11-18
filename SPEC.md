---
references:
  - server/DESIGN.md
  - flow-runtime/docs/flow-spec.md
---

# ursi-flow

## 功能意图

ursi-flow 把可重复的工作过程写成以 `FLOW.md` 为入口的包。用户通过 Web、HTTP API 或本机 CLI 维护流程包、启动和停止运行、查看节点结果。Flow Runtime 校验并执行包，根据节点报告的结果选择下一步，保存每次运行的历史。

## 模块地图

| 模块 | 职责 |
| --- | --- |
| [flow-runtime](flow-runtime/SPEC.md) | Node.js 引擎与本地执行器。`ursi-flowd` 管理包修订、执行配置、后台运行与历史；`ursi-flow-local` 用于单次本地执行。 |
| [flow-runtime/client](flow-runtime/client/SPEC.md) | Rust `FlowClient` 与 `ursi-flow` CLI，通过 Unix socket 访问 daemon。 |
| [server](server/SPEC.md) | `ursi-server` 管理自己的 daemon 子进程，通过 SDK 提供带 Bearer 鉴权的 HTTP API，可选托管 Web 构建产物。 |
| [web](web/SPEC.md) | 通过同源 API 编辑包、管理运行和配置；对话页是独立的本地演示。 |
| [ursi-sandbox](ursi-sandbox/SPEC.md) | 独立交付的沙箱 Gateway、Runtime 和 Client。本地 Flow 执行不依赖该工作区。 |

## 关键功能与验收

### 校验与发布流程包

#### 验收

- 校验含 `FLOW.md` 及其引用文件的草稿后，目录中的已发布包不变。非法更新保留原修订。
- 按预期修订更新成功后，新运行使用新修订。提交过期修订返回冲突。

### 在受信工作区执行与查询

#### 验收

- HTTP 从已发布的包发起运行，只接受管理员映射的 `default` 工作区。命令在该目录执行，运行历史可查到节点结果与命令输出。
- 通过 HTTP 启动的运行可由连接同一 daemon 的 CLI 查询和停止；删除流程包或正常重启服务后，已完成运行的历史仍可读取。
- Web 通过同源 API 读取和修改运行配置。缺失或错误的 API token 返回 401，配置保持不变。
