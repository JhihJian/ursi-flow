---
parent: ../../../SPEC.md
references:
  - ../../../DESIGN-v2.md
---

# 工作定义目录

## 功能意图

资源、执行器和工作包独立发布。工作项选择一个明确的包版本，使用该版发布时确定的 SOP、验收标准、执行器与资源内容。

## 关键功能与验收

### 发布与读取

#### 验收

- 下表的 `{collection}` 为 `resources`、`executors` 或 `packages`，路径相对 `/api/v2`。发布成功返回新版本正文，修订号由服务端从 1 递增。失败不占用版本号。

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| POST | `/{collection}` | 校验并发布请求中的定义 |
| GET | `/{collection}` | 所有对象的最新版数组，含当前 `active` 状态 |
| GET | `/{collection}/{id}` | 对象最新版，含 `active` |
| GET | `/{collection}/{id}/revisions` | 按版本从早到晚列出冻结正文 |
| GET | `/{collection}/{id}/revisions/{revision}` | 指定版本的冻结正文 |
| POST | `/{collection}/{id}/deactivate` | 停用整个 ID，下次派工及新引用返回 409，历史读取不变 |

- 资源 `prompt`、`skill` 接受非空文本；`mcp` 只接受形如 `{"serverRef":"tools","credentialRef":"tools-auth"}` 的命名引用，`credentialRef` 可省略。连接参数和凭据由管理员管理。当前执行后端均不支持注入 MCP，绑定时拒绝发布。
- `agent` 可用 `environment` 枚举绑定执行环境：省略或 `local` 使用本地 Pi，`sandbox` 仅使用管理员预配的 ACP 沙箱。显式字段冻结到动作快照；未声明环境的包保留原投影。`flow` 拒绝此字段。环境不可用时拒绝执行，不改变绑定。
- `agent` 使用服务端配置的程序。`flow` 必须携带 `flowId` 和字符串 `flowRevision`，当前不支持注入资源。程序、命令、工作目录与环境变量均不属于发布字段。

### 引用校验与历史冻结

#### 验收

- 包、动作及执行器均可用 `resources` 引用资源。各动作合并三层依赖，同一资源的同一版只保留一次，不同版返回冲突。动作的 `executor` 和每个资源引用都必须使用 `{id, revision}`。任一引用缺失、停用或不兼容，整个发布失败。
- 可选 `inputs`、`outputs` 为字段名到 JSON 类型名的对象，如 `{"ticket":"string"}`。包为动作提供默认声明，动作可单独声明。执行器要求的输入、动作要求的输出必须分别由另一方提供同名同类型的字段。此检查发生在发布时。
- 同一工作包发布新版 SOP、验收标准或动作绑定后，按旧修订读取仍得到旧版 SOP、标准和动作所绑定的执行器版本。
- 更新资源、执行器或包后，旧包仍引用原版内容。新建工作项时检查包及快照中的依赖是否停用，读取历史不检查停用状态。重复停用不删除版本，停用后的 ID 不再发布新版。

## HTTP 示例

假设三个 ID 尚未发布，执行以下命令创建 `triage` 第 1 版：

```bash
api=http://127.0.0.1:8080/api/v2
auth="Authorization: Bearer $URSI_API_TOKEN"
post() { curl -fsS -H "$auth" --json "$2" "$api/$1"; }
post resources '{"id":"guide","kind":"skill","content":"列出材料及核查结果。"}'
post executors '{"id":"assistant","kind":"agent","resources":[{"id":"guide","revision":1}]}'
post packages '{"id":"triage","sop":"按材料逐项核查。","acceptance":"结论有证据。","actions":{"analyze":{"executor":{"id":"assistant","revision":1}}}}'
curl -fsS -H "$auth" "$api/packages/triage/revisions/1"
curl -fsS -X POST -H "$auth" "$api/packages/triage/deactivate"
```
