---
parent: ../SPEC.md
references:
  - README.md
---

# Flow 客户端

## 功能意图

独立 Rust SDK 与 CLI 面向同一账户下的 Runtime 提供配置、包管理、运行控制与历史查询。

## 关键功能与验收

### 跨进程使用同一运行

客户端仅传递请求，由 Runtime 持有目录版本、后台任务与执行记录。

#### 验收

- 校验包不改变目录。非法更新保留原包；合法更新后新 Run 使用新修订。
- 第一次调用启动长命令后退出，第二次调用查询节点并停止该命令。相同运行标识重复提交不额外执行。
- SDK `start_pinned` 在一个启动请求中携带目录修订。首次启动时修订过期或同一 ID 的绑定冲突，返回 `io::ErrorKind::AlreadyExists`。绑定一致的重试返回原 Run，CLI 可按同一 ID 查询其节点历史。
- SDK `start_with_executor` 或 CLI 的 `run start <Flow ID> <变量JSON> <Run ID> <executorRef JSON>` 可将已发布的执行器引用交给 daemon。`run resume <Run ID>` 核实未确认的平台 Run，已请求取消时只能重试 `run stop`。
- 删除 Flow 后可以读取原运行的命令输出与结果，服务重启后仍可查询。
