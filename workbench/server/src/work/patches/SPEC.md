---
parent: ../../../SPEC.md
depends-on:
  - ../directories/SPEC.md
references:
  - ../../../../../docs/design/workbench/WORK-LIST-DESIGN.md
  - ../../../../../docs/design/workbench/SERVER-WORK-MANAGEMENT.md
  - HTTP.md
---
# 业务工作包

## 功能意图

Workbench 在 `work.json` 的 `workPatches` 中登记工作包，以 `directoryId` 引用业务文件。配置包及其目录由独立执行器平台管理。工作包可保存平台配置包 ID，不持有配置文件或快照。

## 关键功能与验收

### 建包与文件

#### 验收

- 仅凭名称即可创建工作包。名称去除首尾空白后为 1 至 80 个字符，不含控制字符。创建、列表与详情均返回 `id`、`name`、`directoryId`、来源、创建时间、初始执行状态和当前归属。
- 手动工作包从空目录开始，生成包引用本次转换写入的目录。包和目录在同一笔存储更新中登记，失败不公布半成品。独立建目录不产生包记录。
- 创建请求可附 `configPackage: {id}`。Workbench 向平台核验该包 ID，仅保存引用。ID 无效、包不存在或平台无法确认时拒绝创建，不使用旧业务库中的配置包记录兜底。
- Workbench 不挂载 `/api/v2/patches/config`。旧库的配置目录与执行器制品目录不出现在业务目录列表，按原目录 ID 读写均返回 404。

### 当前归属与生成来源

#### 验收

- 手动工作包可在创建时或建包后设置 `workItemId`。非空引用必须指向存在的清单项，传 `null` 可解绑。
- 生成包将快照来源保存在 `provenance`，初始归属为发起生成的工作项。改绑、解绑或删除该工作项后，文件、目录标识与生成来源保持原样。
