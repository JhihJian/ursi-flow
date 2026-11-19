# 工作包与配置包记录

在 `/api/v2` 下使用管理令牌。`kind` 为 `work` 或 `config`。

| 请求 | 结果 |
| --- | --- |
| `POST /patches/{kind}`，`{"name":"结算排查"}` | 创建包及其引用的目录，返回 `{id,name,directoryId}` |
| `GET /patches/{kind}` | 本类包记录数组 |
| `GET /patches/{kind}/{id}` | 一条包记录，其他类别或未知标识返回 404 |

文件树和正文属于[虚拟目录资源](../directories/HTTP.md)。例如先从记录取得 `directoryId`，再请求 `GET /directories/{directoryId}/tree`。只需要存放文件时，也可直接 `POST /directories`（正文 `{}`），不必创建包。
