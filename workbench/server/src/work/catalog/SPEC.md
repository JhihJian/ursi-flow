---
parent: ../../../SPEC.md
references:
  - ../../../DESIGN-v2.md
  - ../../../../EXECUTOR-DESIGN.md
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
- 执行器是通用能力定义，只允许 `id`、`resources` 和可选的 `configSchema`。定义不接受 `kind`、`environment`、`flowId`、`flowRevision`、程序、路径、命令或环境变量字段。
- `configSchema` 支持字段数组或 `{fields:[...]}`。每个字段包含 `key`、`label`、`type`，可选 `description`、`required`、`default`、`options`、`min`、`max`。字段类型支持 `string`、`url`、`secret`、`enum`、`integer`、`number`、`boolean`、`configPackage`。它不是任意 JSON Schema，不支持对象、数组、组合、表达式或执行配置。
- `url` 默认值必须是无空白的绝对 URL；`enum` 必须有非空且不重复的字符串 `options`；`integer` 和 `number` 可声明有限的 `min`、`max`，且默认值必须在边界内；`configPackage` 默认值必须是不含路径的配置包标识。未声明 `default` 的字段没有默认值。
- `secret` 只能使用 `"***"`、`{"redacted":true}` 或命名的内部引用 `{"ref":"secret://..."}` 表示。明文密钥、路径、命令和环境变量均拒绝，secret 值不进入普通响应。

### 引用校验与历史冻结

#### 验收

- 包、动作及执行器均可用 `resources` 引用资源。各动作合并三层依赖，同一资源的同一版只保留一次，不同版返回冲突。动作的 `executor` 和每个资源引用都必须使用 `{id, revision}`。任一引用缺失、停用或资源类型不受支持，整个发布失败。
- `inputs`、`outputs` 只属于包和动作，是字段名到 JSON 类型名的业务声明，如 `{"ticket":"string"}`。执行器不声明业务端口；它只接收平台生成的 `workspace` 与 `workInstruction`，输出 `artifactDirectory`。动作可选 `configPackage: {"id":"<config-patch>"}`，平台在发布时校验引用，并在每次尝试中生成独立、只读的配置快照。包和动作的声明仍在目录发布时校验格式，但不再与执行器做端口兼容匹配。
- 同一工作包发布新版 SOP、验收标准或动作绑定后，按旧修订读取仍得到旧版 SOP、标准和动作所绑定的执行器版本。
- 更新资源、执行器或包后，旧包仍引用原版内容。新建工作项时检查包及快照中的依赖是否停用，读取历史不检查停用状态。重复停用不删除版本，停用后的 ID 不再发布新版。

## HTTP 示例

假设三个 ID 尚未发布，执行以下命令创建 `triage` 第 1 版：

```bash
api=http://127.0.0.1:8080/api/v2
auth="Authorization: Bearer $URSI_API_TOKEN"
post() { curl -fsS -H "$auth" --json "$2" "$api/$1"; }
post resources '{"id":"guide","kind":"skill","content":"列出材料及核查结果。"}'
post executors '{"id":"assistant","resources":[{"id":"guide","revision":1}],"configSchema":{"mode":{"type":"enum","values":["fast","safe"],"default":"safe"}}}'
post packages '{"id":"triage","sop":"按材料逐项核查。","acceptance":"结论有证据。","actions":{"analyze":{"executor":{"id":"assistant","revision":1}}}}'
curl -fsS -H "$auth" "$api/packages/triage/revisions/1"
curl -fsS -X POST -H "$auth" "$api/packages/triage/deactivate"
```
