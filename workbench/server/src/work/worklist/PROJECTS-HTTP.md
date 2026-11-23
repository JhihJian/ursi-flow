# 项目规划 HTTP 契约

以下路径以 `/api/v2` 为前缀，使用管理令牌。项目工作区汇总当前规划结构、布局和原有工作项。规划操作只组织事项，工作包生成和执行仍由各自入口显式发起。

| 请求 | 请求体与响应 |
| --- | --- |
| `GET /work-projects` | 返回 `Project[]`。 |
| `POST /work-projects` | `{name}`。返回 `Project`，同时创建一张默认画布。 |
| `PUT /work-projects/{projectId}` | `{name,revision}`。返回更新后的 `Project`。 |
| `DELETE /work-projects/{projectId}` | 删除项目及所属图，成功返回 204。项目中仍有事项时返回 409。 |
| `GET /work-projects/{projectId}/workspace` | 返回项目工作区快照。 |
| `GET /work-items/{id}/placement` | 返回 `{projectId,canvasId,taskCardId}`。事项未放置时返回 `null`，事项不存在时返回 404。 |
| `POST /work-projects/{projectId}/commands` | 提交结构命令。创建命令返回 `{id}`，其余命令返回 `{}`。 |
| `PUT /work-projects/{projectId}/layout` | `{canvasId,revision,positions}`。返回更新后的 `Layout`。 |

项目、画布、任务卡名称去除首尾空白后须非空，且不得含控制字符。`Project` 为 `{id,name,revision}`。项目创建后结构修订为 1。

## 工作区快照

| 字段 | 形状与含义 |
| --- | --- |
| `project` | `Project`。 |
| `canvases` | `[{id,name}]`，按创建顺序返回，默认画布存在时位于首项。 |
| `taskCards` | `[{id,canvasId,name}]`。 |
| `items` | `[{item: WorkItem,taskCardId,rank}]`。`item` 沿用[工作清单](HTTP.md)响应形状，`rank` 为卡内从 0 开始的顺序。 |
| `relations` | `[{id,canvasId,from,to}]`。`canvasId` 为 `null` 表示地图关系，端点是画布 ID；否则为画布关系，端点是该画布内的任务卡 ID。箭头从 `from` 指向 `to`。 |
| `layouts` | `{map: Layout,canvases: Record<canvasId,Layout>}`。`Layout` 为 `{revision,positions}`，`positions` 是从节点 ID 到 `{x,y}` 的对象。 |

快照在一次存储读取中生成。全局清单继续返回所有事项，项目快照只返回已放置到本项目的事项。

## 结构命令

请求体为 `{revision,type,...}`，下表列出相应 `type` 的额外字段。

| `type` | 额外字段 | 操作 |
| --- | --- | --- |
| `createCanvas` | `name` | 在项目末尾添加画布。 |
| `renameCanvas` | `canvasId`, `name` | 改名。 |
| `deleteCanvas` | `canvasId` | 删除没有事项的画布及其任务卡、关系和布局。项目至少保留一张画布。 |
| `createTaskCard` | `canvasId`, `name` | 在画布内添加任务卡。 |
| `renameTaskCard` | `taskCardId`, `name` | 改名。 |
| `deleteTaskCard` | `taskCardId` | 删除空任务卡及其关联边和坐标。 |
| `createItem` | `taskCardId`, `title`, `description?`, `category?` | 按全局清单新建规则创建事项，同时追加到卡末尾。 |
| `placeItem` | `workItemId`, `taskCardId` | 将未归属事项或同项目事项追加到目标卡末尾。`taskCardId: null` 移出项目，保留工作项。跨项目转移须先从来源项目移出。 |
| `reorderItems` | `taskCardId`, `itemIds` | 完整替换该卡内的事项顺序。数组必须恰好包含该卡的所有事项，每项一次。 |
| `createRelation` | `canvasId`, `from`, `to` | 创建关系。`canvasId: null` 选择地图，否则选择对应画布。 |
| `replaceRelation` | `relationId`, `from`, `to` | 替换端点，保持原 ID 和作用域。 |
| `deleteRelation` | `relationId` | 删除关系。 |

结构命令和项目改名校验 `Project.revision`，成功后递增修订。经旧接口删除已放置事项时，同一事务清除放置、递增项目结构修订并解绑原工作包。放置、排序、改关系和保存布局均保持事项内容修订。

## 布局和错误

布局请求显式指定 `canvasId`，传 `null` 选择地图。地图和每张画布的布局修订各从 0 开始。`positions` 全量替换当前图的坐标，传 `{}` 重置。坐标只能引用当前图内的节点，`x`、`y` 为有限数值。保存成功递增该图的布局修订，不改项目结构修订。删除节点时清理其已存坐标并递增对应布局修订。

修订过期、待删除目标仍含事项、删除最后一张画布或事项已归属其他项目时，返回 409，客户端应重读工作区。请求引用的资源不存在时返回 404。越界端点、重复边、自环、成环、非法坐标或不完整排序返回 400。请求体字段或类型不合约时，JSON 提取器返回 4xx。失败请求不提交部分修改。
