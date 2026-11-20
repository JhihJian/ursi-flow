# 工作清单 HTTP 契约

以下路径以 `/api/v2` 为前缀，使用管理令牌。

| 请求 | 请求与响应 |
| --- | --- |
| `POST /work-items` | `{title,description?,category?,recipe?}`。返回新工作项。 |
| `GET /work-items` | 返回工作项数组。可按 `category` 或 `status` 筛选；同时传入时取交集，如 `?category=continuous&status=active`。 |
| `GET /work-items/{id}` | 返回 `{id,title,description,category,status,recipe,revision}`。未知项返回 404。 |
| `PUT /work-items/{id}` | 除新建字段外可传 `status`，标题必填。省略 `category` 或 `status` 时保留该字段当前值；省略说明或配方则分别替换为空字符串或 `null`。可传读取时的 `revision` 作写入前提；不匹配返回 409。成功返回更新后的事项。 |
| `DELETE /work-items/{id}` | 删除事项并清除包的当前归属，成功返回 204。 |
| `POST /work-items/{id}/generate` | `{requestId}`，返回一条[工作包记录](../patches/HTTP.md)。 |

标题去除首尾空白后须非空。说明默认空字符串。`category` 指工作类别，取 `one_time`（一次性）或 `continuous`（持续）；`status` 指办理状态，取 `pending`（待开始）、`active`（进行中）或 `completed`（已完成）。新建时类别默认 `one_time`，状态由服务端设为 `pending`；创建请求指定状态返回 400。写入和筛选仅接受对应字段的枚举值。配方默认 `null`；非空时为 `{resources:[{alias,serverId,uri}],script}`。脚本及资源列表须非空，资源别名在同一配方内唯一。保存配方不要求服务在线。

`requestId` 为 1 至 256 字节的非空白字符串，作用域是工作项 ID。一次主动生成使用一个新标识。响应丢失后用同一标识重试，已发布的包按 ID 读回，即使当前归属或事项定义已变化。生成不改变类别或办理状态。无配方返回 400，检查修订时发现事项已删除或变化返回 409，转换失败不会发布包。

包列表以 `workItemId` 标识当前归属，详情页与清单计数可按该字段筛选包列表。独立的 `provenance` 保存生成时的来源。
