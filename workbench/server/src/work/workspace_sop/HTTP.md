# 手动工作包接口

以下路径相对 `/api/v2`，使用工作台已有的 Bearer 鉴权。

| 请求 | 结果 |
| --- | --- |
| `GET /workspace-types` | 类型、必填材料角色、推荐默认 SOP 引用 |
| `GET /sops` | 所有已发布修订的数组，包含内置 `receipt@1`，按标识和修订号排序 |
| `POST /sops` | 发布 `{ "id":"receipt", "executor":"echo", "config":{"title":"项目交接记录"} }`，服务端分配修订号。内置 `receipt@1` 始终存在 |
| `GET /sops/{id}/revisions/{revision}` | 读取固定修订 |
| `POST /workspaces` | 建草稿，只接受 `{"typeId":"finding-report","requirement":"核对本单材料"}`。携带 `sop` 返回 422 |
| `GET /workspaces`、`GET /workspaces/{id}` | 列出或读取工作包，`ready` 表示需求和材料已备齐 |
| `PATCH /workspaces/{id}` | 保存 `{"requirement":"修订后的需求"}` |
| `PUT /workspaces/{id}/materials/{role}?name=...` | 请求体为文件原始字节，文件名按 URL 编码。返回更新后的详情 |
| `DELETE /workspaces/{id}/materials/{role}` | 撤回未冻结工作包的一个角色材料，使其可重新上传。返回更新后的详情。已冻结时返回 409 |
| `POST /workspaces/{id}/attempts` | 提交 `{}` 使用类型推荐默认版本，或提交 `{"sop":{"id":"receipt","revision":2}}` 显式选版。返回详情，从 `attempts[].sop` 读取本次冻结的完整定义 |
| `GET /workspaces/{id}/attempts/{attempt}/receipt` | 查看该次纯文本回执；加 `?download=true` 下载 `receipt.md` |

草稿缺件仍能保存，材料齐且需求非空时 `ready` 为 true。开始执行后不允许再修改该单材料和需求。同单可以显式换版重跑，每次追加独立尝试，旧尝试和原回执保持原版本。
