# 手动工作包接口

以下路径相对 `/api/v2`，使用工作台已有的 Bearer 鉴权。

| 请求 | 结果 |
| --- | --- |
| `GET /workspace-types` | 类型、必填材料角色、默认 SOP 引用 |
| `POST /sops` | 发布 `{ "id":"receipt", "executor":"echo", "config":{"title":"项目交接记录"} }`，服务端分配修订号。内置 `receipt@1` 始终存在 |
| `GET /sops/{id}/revisions/{revision}` | 读取固定修订 |
| `POST /workspaces` | 建草稿，例如 `{"typeId":"finding-report","requirement":"核对本单材料"}`，可提供 `sop:{id,revision}` 覆盖默认绑定 |
| `GET /workspaces`、`GET /workspaces/{id}` | 列出或读取工作包 |
| `PATCH /workspaces/{id}` | 保存 `{"requirement":"修订后的需求"}` |
| `PUT /workspaces/{id}/materials/{role}?name=...` | 请求体为文件原始字节，文件名按 URL 编码。返回更新后的详情 |
| `POST /workspaces/{id}/attempts` | 提交 `{}`，校验材料并执行。返回详情，从 `attempts` 读取本次状态 |
| `GET /workspaces/{id}/attempts/{attempt}/receipt` | 查看该次纯文本回执；加 `?download=true` 下载 `receipt.md` |

草稿缺件仍能保存。开始执行后不允许再修改该单材料和需求。重跑追加一次独立尝试；原回执不被替换。
