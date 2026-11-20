# 工作包与配置包记录

在 `/api/v2` 下使用管理令牌。`kind` 为 `work` 或 `config`。

| 请求 | 结果 |
| --- | --- |
| `POST /patches/{kind}`，`{"name":"结算排查"}` | 创建包及其引用的目录，返回 `{id,name,directoryId}`。工作包可附带 `configPackage:{"id":"…"}` 引用已有配置包，也可传 `workItemId` 指定已有工作清单项。 |
| `GET /patches/{kind}` | 本类包记录数组 |
| `GET /patches/{kind}/{id}` | 一条包记录，其他类别或未知标识返回 404 |
| `PATCH /patches/work/{id}`，`{"workItemId":"…"}` 或 `{"workItemId":null}` | 设置或清空当前归属，返回完整工作包记录。未知工作项或工作包返回 404。 |

工作包的创建、列表与详情还返回 `workItemId`（无归属为 `null`）、`source`（`manual` 或 `generated`）、`createdAt`（服务端 Unix 秒）和 `executionStatus`（新建为 `not_started`）。是否已执行和结果状态由同一字段展示，配置包不附加这些字段。配置引用只返回 `{id}`，不会展开配置内容或宿主路径。

生成包另有 `provenance`，记录生成时的工作项、修订、脚本摘要与资源读取证据。改绑或删除清单项只改变当前归属。

文件树和正文属于[虚拟目录资源](../directories/HTTP.md)。例如先从记录取得 `directoryId`，再请求 `GET /directories/{directoryId}/tree`。只需要存放文件时，也可直接 `POST /directories`（正文 `{}`），不必创建包。

## 执行边界

配置包参与执行时，execute 在把配置内容交给执行器前必须调用 `snapshot_config_package(store, attemptId, configPackageId)` 建立尝试级快照。返回的 `snapshotDirectoryId` 是新的、已冻结的目录能力引用，另有 `sourcePackageId` 和 `contentDigest` 用于审计。执行器只能使用这个快照目录，不能使用源配置包的 `directoryId`，也不会看到宿主路径。该快照操作不是独立 HTTP 接口，完整尝试记录仍由 execute 模块保存。
