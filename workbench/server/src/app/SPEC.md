---
parent: ../../SPEC.md
depends-on:
  - ../flow/SPEC.md
  - ../transport/SPEC.md
  - ../../../../flow-runtime/client/SPEC.md
references:
  - ../../../../docs/design/workbench/SERVER-FLOW.md
  - ../../README.md
---

# Server 应用装配

## 功能意图

将部署者指定的 API 身份、数据目录和工作区装配成可用的 HTTP 服务。`app` 打开私有工作存储，将 v2 工作路由交给统一鉴权层。启用 Flow 时才持有 daemon 子进程句柄，把连接同一 socket 的 `FlowClient` 用于 v1 管理。

## 关键功能与验收

### 配置与就绪

#### 验收

- `URSI_API_TOKEN` 必填，只接受非空、无空格的可见 ASCII 字符。仅提供令牌时，使用 `0.0.0.0:8080`、数据根目录 `data`、`PATH` 中的 `ursi-flowd` 和当前工作目录。
- `URSI_LISTEN_ADDR`、`URSI_DATA_DIR`、`URSI_FLOWD_BIN` 和 `URSI_WORKSPACE_DIR` 分别覆盖上述设置。HTTP 使用 `default` 指代配置的工作区。
- `URSI_FLOW_ENABLED` 默认 `1`，只接受 `0` 或 `1`。启用时，子进程的 `URSI_FLOW_HOME` 指向私有 `<数据目录>/flow-runtime/`，Server 等待子进程就绪通知后提供 HTTP 服务。关闭时不启动 daemon、不挂载 v1，v2 工作路由仍可用。
- Server 独占 `<数据目录>/work/work.lock`。`work/` 必须是私有目录，拒绝符号链接及组或其他账户可访问的目录。清单、工作包及独立定义的元数据原子写入 `work.json`，与 daemon 的历史和 socket 分开保存。
- 升级时先取得独占锁，再删除旧派工单据（含尝试与交付）、模板及尝试级配置快照。仅清理制品或快照记录指向、已登记且没有其他引用的目录，不扫描删除无主目录，不跟随符号链接或跨挂载点。清理失败时拒绝启动，保留原元数据以便重试。
- 缺少令牌、地址无效、daemon 无法执行或就绪失败时不报告服务可用。诊断不输出令牌。

### 独占与关闭

#### 验收

- 启用 Flow 时，启动前已有 `runtime.sock` 则拒绝启动，不收养已有 daemon，不删除或替换 socket。
- 子进程已启动但服务装配失败时，回收本次启动的进程。收到 `SIGTERM` 或 `SIGINT` 时停止 HTTP 并等待自己的 daemon 退出，正常退出不遗留 socket 或受管命令。
- 启用 Flow 时，再次启动使用新的 daemon 进程，沿用原数据目录可以读回已保存的配置、包和历史。
