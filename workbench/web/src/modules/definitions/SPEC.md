---
parent: ../../../SPEC.md
depends-on:
  - ../../shared/SPEC.md
  - ../../../../server/src/work/catalog/SPEC.md
references:
  - ../../../../EXECUTOR-DESIGN.md
---
# 工作定义

## 功能意图

维护资源和执行器，按固定版本核对依赖并发布新版。

## 关键功能与验收

### 目录、历史和跳转

#### 验收

- `/resources` 和 `/executors` 列出最新版本及对象启停状态。执行器目录额外展示固定契约 `workspace + workInstruction → artifactDirectory`、固定资源摘要和配置字段数量；资源可按 Skill、提示词和 MCP 引用筛选。读取失败提供重试，成功但无结果显示空态。
- `/:id` 读取最新详情，`/:id/revisions` 展示历史，`/:id/revisions/:revision` 直接打开冻结正文。查看旧版本时同一行同时显示正在阅读的修订号、最新修订号和对象启停状态，并标明历史版本只读。
- 执行器详情展示 `workspace + workInstruction → artifactDirectory` 契约、资源依赖、configSchema 动态表单和日志记录位置。
- 确认停用前告知对新引用的影响。停用后仍可打开历史版本。

### 表单发布

#### 验收

- 从各目录的 `/new` 可发布资源和引用它的通用执行器。执行器表单只提交 ID、固定资源和可选 configSchema，并以只读方式展示通用执行契约。普通流程通过有标签的输入框、选择器和可增删的字段行完成。小屏表单按单列排列。
- MCP 资源只填写服务与凭据引用，页面说明连接参数由管理员管理、当前执行后端不支持运行时注入，因此不能选为可执行依赖。执行器不提供 Agent、Flow、环境或后端绑定选择，程序、工作目录、环境变量和命令由服务端管理。
- 指定版本的 `/edit` 基于该版生成草稿。缺少可用资源时，执行器表单提供新建资源的入口。未发布的草稿只保存在当前标签页，返回同一编辑页时提示已恢复并允许放弃；发布失败或校验失败保留已填内容，成功后清除草稿并打开响应给出的新版本。停用的 ID 不提供发布入口。
- 执行器定义只保留 `id`、`revision`、`resources`、`configSchema`。响应中的 `configSchema` 只依据服务端 schema 渲染 `string`、`url`、`secret`、`enum`、`integer`、`number`、`boolean` 和 `configPackage` 动态表单，默认值仅用于展示；发布请求不生成 `config`，也不新增或推导 `kind`、`environment`、`flowId`、`flowRevision` 字段。
- 动态表单区分 schema 默认值与未声明值，`false` 和 `0` 正常展示。`secret` 只显示受控的密码控件和服务端管理提示，不回显内部引用或明文；配置值不进入发布请求。
- `configPackage` 只消费配置包的公开 `id/name`，通过 `/api/v2/patches/config` 读取，不显示 `directoryId`、宿主路径或目录内容。服务端未提供 schema 时，编辑器不显示动态字段区。
