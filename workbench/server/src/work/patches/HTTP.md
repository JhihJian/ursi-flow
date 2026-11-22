# 工作包与配置包 HTTP 契约

两套服务各有自己的 `/api/v2`。工作包请求发送给 Workbench，使用 Workbench API 令牌。配置包管理请求直接发送给执行器平台，使用平台管理员令牌。

## Workbench：工作包

以下路径相对于 Workbench 的 `/api/v2`。

| 请求 | 结果 |
| --- | --- |
| `POST /patches/work`，`{"name":"结算排查"}` | 创建工作包和空业务目录，返回完整工作包记录。可附 `workItemId` 指定已有清单项。 |
| `GET /patches/work` | 工作包记录数组 |
| `GET /patches/work/{id}` | 工作包详情，未知标识返回 404 |
| `PATCH /patches/work/{id}`，`{"workItemId":"…"}` 或 `{"workItemId":null}` | 设置或清空当前归属，返回完整工作包记录。未知工作项或工作包返回 404。 |

工作包记录含 `id`、`name`、`directoryId`、`workItemId`（无归属为 `null`）、`source`（`manual` 或 `generated`）、`createdAt`（服务端 Unix 秒）和 `executionStatus`（新建为 `not_started`）。生成包另有 `provenance`，记录生成时的工作项、修订、脚本摘要与资源读取证据。改绑或删除清单项只改变当前归属。

创建时可附 `configPackage: {"id":"<平台配置包 UUID>"}`。该字段使用配置包记录 ID。Workbench 只在平台确认引用后建包，响应仅保留 `{id}`。平台报告记录不存在时返回 404，无法核验时返回 503，不查旧本地配置表。Workbench 消费者令牌仅可核验已知 UUID，平台只返回 `{id}`。名称、目录及列表仍仅对管理员开放。普通工作包可省略该字段，无需查询平台配置包。

文件读写使用 Workbench 的[业务目录接口](../directories/HTTP.md)，例如 `GET /directories/{directoryId}/tree`。也可直接 `POST /directories`（正文 `{}`）创建独立业务目录。执行制品另用尝试响应中的 `platform-artifact-{attemptId}` 句柄只读访问，不出现在业务目录列表。

## 执行器平台：配置包

以下路径仅在[平台](../../../../../executor-platform/server/README.md)的 `/api/v2` 提供。Workbench 没有对应的管理路由。

| 请求 | 结果 |
| --- | --- |
| `POST /patches/config`，`{"name":"审核配置"}` | 创建平台配置包及其目录，返回 `{id,name,directoryId}`。 |
| `GET /patches/config`、`GET /patches/config/{id}` | 查询配置包列表或详情。 |

管理员使用平台的 `/directories/{directoryId}` 文件接口维护 `AGENTS.md`、`skills/` 和 `mcp.json`。三处位置固定，`mcp.json` 必须是 JSON 对象。新包初始化为空提示词、空技能目录和 `{"mcpServers":{}}`。配置包不关联业务清单项。Agent 发布或草稿试跑按配置包 `id` 读取当时的文件，后续编辑不改变已冻结的快照，详见[Agent 定义契约](../catalog/HTTP.md#agent-执行器)。
