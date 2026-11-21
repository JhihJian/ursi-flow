# 工作包生成器 HTTP 契约

路径相对 `/api/v2`，均使用工作台管理令牌，与 Flow 无关。

## 定义与修订

| 请求 | 结果 |
| --- | --- |
| `POST /work-patch-generators` | 提交 `{id,name,aliases,script}`，返回正文及新分配的 `revision`。修订从 1 递增，历史正文不可修改。 |
| `GET /work-patch-generators` | 列出各生成器的最新修订。 |
| `GET /work-patch-generators/{id}` | 读取最新修订。 |
| `GET /work-patch-generators/{id}/revisions` | 按修订从早到晚列出历史。 |
| `GET /work-patch-generators/{id}/revisions/{revision}` | 读取指定修订。 |

`id` 使用工作定义目录标识规则，`new` 保留给页面路由。名称最长 80 字符。`aliases` 最多 32 个，可为空，每个别名须非空且唯一，最长 128 字节。脚本须非空，最多 64 KiB。发布只保存定义，不读取输入或执行脚本。

## 提交运行与读取记录

向 `PUT /work-patch-generation-runs/{runId}` 提交以下一种请求。`runId` 必须为小写 UUID v4。

```json
{"generator":{"id":"weekly","revision":1},"resources":[{"alias":"feedback","serverId":"registered-id","uri":"feedback://weekly"}]}
```

```json
{"workItemId":"item-id"}
```

试运行的资源引用须与指定修订的别名一一对应。工作项生成使用已保存的[生成器绑定](HTTP.md)，并固定接收时的事项快照。新请求受理后返回 `running` 记录，运行不依赖提交连接是否仍打开。相同 ID 和相同请求返回现有记录，不会再次读取或转换。相同 ID 配不同请求返回 `409`。资源数组顺序属于请求的一部分。并发运行达到上限时，新请求返回 `503`，不占用 ID。

`GET /work-patch-generation-runs/{runId}` 读取详细记录，未知 ID 返回 `404`。`GET /work-patch-generation-runs` 按开始时间倒序返回最多 100 条，可传 `offset` 跳过记录，或以 `generatorId`、`workItemId` 筛选（同时传入取交集）。

每条记录含 `id`、`generator:{id,revision}`、`resources`、`initiator`、`startedAt`、`status`，工作项生成还含 `workItemId`、`workItemTitle`、`workItemRevision`。`initiator` 为 `workbench-admin`，表示服务端验证了共享管理令牌，不代表个人账户。时间以 Unix 毫秒表示。正常到达终态时记录 `finishedAt` 和已读取资源的 `evidence`（引用、`sha256`、`readAt`），不保存输入正文或凭据。

| 状态 | 附加字段 |
| --- | --- |
| `running` | 已登记，尚未结束。 |
| `succeeded` | `result:{name,directoryId,files:[{path,bytes,sha256}],workPatchId?}`。试运行目录只读，不返回 `workPatchId`。工作项生成的工作包可编辑，记录中的文件清单仍是发布时的清单。 |
| `failed` | `error:{stage,message}`。阶段为 `read`、`convert`、`validate` 或 `publish`，无已登记产物。 |
| `interrupted` | `error:{stage:"interrupted",message}` 和结束时间。服务重启把未提交发布的运行标为中断，不自动重跑。 |

工作项删除或包归属调整后，运行记录仍可读取，包来源保留 `provenance.runId`。工作项的类别和状态不随生成改变。
