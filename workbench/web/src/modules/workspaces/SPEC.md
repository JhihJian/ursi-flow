---
parent: ../../../SPEC.md
depends-on:
  - ../../shared/SPEC.md
references:
  - ../../../DESIGN-v2.md
---
# 线索报告工作区

## 功能意图

让经办人从工作清单进入独立于工作项的工作区：按需求创建、准备各角色材料、执行内置 SOP，并查看每次尝试和回执。工作区数据与工作项、工作包定义互不影响。

## 关键功能与验收

### 列表与新建

#### 验收

- `/workspaces` 读取 `GET /workspaces`，逐项显示需求、类型名称、材料数、执行次数、最近尝试状态和是否冻结；每项进入 `/workspaces/:id`。
- 列表加载失败显示故障和重试；成功空列表显示空态并给 `/workspaces/new` 入口。
- `/workspaces/new` 读取 `GET /workspace-types`，选择类型后展示角色标签和 SOP 摘要。需求为空不能提交；提交 `POST /workspaces` 的正文只含 `typeId` 和 `requirement`。
- 创建成功后进入新工作区的准备页；创建失败保留已填需求并显示错误。类型目录为空或故障不显示空表单。

### 需求、材料与冻结

#### 验收

- `/workspaces/:id` 读取详情，显示 SOP 标题、执行器、类型、角色和已有材料名称与大小。
- 保存需求调用 `PATCH /workspaces/:id`，正文只含 `requirement`；空白需求不能保存，失败保留草稿。
- 每个角色可选择一个文件，上传调用 `PUT /workspaces/:id/materials/:role?name=<编码后的文件名>`，正文是文件原始字节，不使用 JSON 或表单编码。
- `frozen` 为真时需求文本框、保存和上传都不可用，并明确说明仍可执行；未冻结时才允许修改需求和材料。
- 任何请求进行中都不重复提交；401 沿用共享客户端的登录处理。

### 执行与回执

#### 验收

- 准备页的「执行一次」在需求有未保存修改时先保存需求，保存失败不发起执行；随后 `POST /workspaces/:id/attempts` 并进入结果页。
- 执行失败也读取服务端保存的失败尝试，不在页面上丢弃记录。冻结后仍可再次执行。
- `/workspaces/:id/result` 逐次显示尝试状态和失败原因，保留全部历史，并可再次执行。
- 回执内容按 `GET /workspaces/:id/attempts/:attempt/receipt` 读取 `text/plain` 并显示原文；读取失败只影响该次回执。
- 下载回执复用鉴权读取，再以 `receipt.md` 交给浏览器保存；非文本、空正文和页面响应都按读取失败处理。
