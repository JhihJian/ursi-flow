---
parent: ../../../SPEC.md
depends-on:
  - ../directories/SPEC.md
references:
  - ../../../../PATCH-STUDIO.md
  - HTTP.md
---
# 工作包与配置包

## 功能意图

每个包是一条元信息记录，通过 `directoryId` 引用一份虚拟目录资源。两种包各用一张逻辑表，沿用工作台的 `work.json` 存储。文件内容由目录服务持有。

## 关键功能与验收

### 建包与列表

#### 验收

- 仅凭名称即可创建。名称去除首尾空白后为 1 至 80 个字符，不含控制字符。列表与详情返回 `id`、`name` 和 `directoryId`。
- 工作包可选 `configPackage: {id}` 引用已存在的配置包。引用只允许这一组字段，配置包不能再引用配置包，未知配置包拒绝创建。
- 新建工作包记录来源、创建时间与初始执行状态，并在列表与详情返回同一份元信息。配置包不记录执行信息。
- 工作包与配置包分别登记在 `workPatches` 与 `configPatches`。资源和包记录在一次存储更新中登记，任一环节失败不会公布半成品。
- 所有文件操作均通过目录资源 ID 完成。单独创建目录不产生包记录，不依赖 SOP 或执行。

### 两种目录的初始内容

#### 验收

- 工作包引用空目录。配置包创建时写入空 `AGENTS.md`、`skills/` 与包含 `{"mcpServers":{}}` 的 `mcp.json`。
- 为配置目录声明固定路径和 JSON 对象约束，通过目录接口也不能移动、删除锚点或用非法 JSON 替换 MCP 文件。普通目录无需这些约定。

### 尝试级配置包快照

#### 验收

- `snapshot_config_package(store, attempt_id, package_id)` 是供 execute 调用的内部 API。它只接受配置包记录，复制源目录内容到新的服务端目录，并立即冻结新目录。
- 快照记录保存 `sourcePackageId`、内容摘要 `contentDigest` 和冻结目录 `snapshotDirectoryId`，以尝试 ID 唯一登记。相同尝试重复调用返回同一快照，不能改绑其他配置包。
- 复制过程不返回宿主路径，不把源目录直接交给执行器。快照目录与源配置包目录物理独立；执行器只应使用快照目录标识，源配置包仍可继续编辑。
- 当前原语在 patches 与 execute 之间提供目录复制和冻结边界。execute 在交给执行器前必须调用该 API，完整执行记录的工作项、尝试及执行器字段由 execute 保存，本模块不修改 execute 模型。
