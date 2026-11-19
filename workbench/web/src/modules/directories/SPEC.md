---
parent: ../../../SPEC.md
depends-on:
  - ../../shared/SPEC.md
references:
  - ../../../../PATCH-STUDIO.md
---
# 虚拟目录

## 功能意图

一个目录是服务私有空间中的一棵文件树，由服务端分配标识。工作包、配置包等业务记录只保存这个标识，虚拟目录可独立创建和读写，业务模块不必各自实现 HTTP 客户端。

## 关键功能与验收

### 目录标识

#### 验收

- `POST /api/v2/directories` 提交空的 JSON 对象，返回 `{id}`；`GET /api/v2/directories/{id}` 返回同一标识，不公布磁盘路径。
- 客户端只按标识拼装 `/api/v2/directories/{id}` 下的 `tree`、`file`、`dir`、`move`、`entry`，相对路径作为查询参数或 JSON 字段传入。

### 目录内容

#### 验收

- 文件读写保留原始字节与空文件；写入默认只新建，`replace=true` 才覆盖。树公布 `{path,kind,size?}`，不包含内部临时文件。
- 目录和文件操作失败时保留 HTTP 状态与服务端错误正文，调用方据此呈现读取失败并重试。
