---
parent: ../../SPEC.md
depends-on:
  - ../flow/SPEC.md
  - ../transport/SPEC.md
references:
  - ../../README.md
  - ../../../../docs/design/workbench/SERVER-WORK-MANAGEMENT.md
---

# Server 应用装配

## 功能意图

将部署者指定的 API 身份、数据目录和工作区装配成可用的 HTTP 服务。`app` 打开私有业务存储，将 v2 业务路由和执行器平台消费者路由交给统一鉴权层。平台管理接口只在独立平台装配。启用 Flow 时才持有 daemon 子进程句柄，把连接同一 socket 的 `FlowClient` 用于 v1 管理。

## 关键功能与验收

### 配置与就绪

#### 验收

- `URSI_API_TOKEN` 必填，只接受非空、无空格的可见 ASCII 字符。入站认证独立于平台身份。监听地址与数据根默认分别为 `0.0.0.0:8080` 和 `data`。
- `URSI_LISTEN_ADDR` 与 `URSI_DATA_DIR` 分别覆盖上述设置。
- 启用或关闭 Flow 都必须配置 `URSI_EXECUTOR_PLATFORM_URL`（平台 HTTP(S) origin）和 `URSI_EXECUTOR_PLATFORM_TOKEN`（Workbench 消费者令牌）。任一项缺失或格式无效时启动失败，不装配本地执行器管理路由作为替代。
- `URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN` 仅供受管 daemon 使用：启动子进程时映射为其 `URSI_EXECUTOR_PLATFORM_TOKEN`，未提供时不传消费者令牌。父进程继续用 Workbench 身份。两者不得共享尝试或制品的访问身份。
- Server 独占 `<数据目录>/work/work.lock`。`work/` 必须是私有目录，拒绝符号链接及组或其他账户可访问的目录。清单、工作包与生成器等业务元数据原子写入 `work.json`。平台使用独立私有根和 `platform.json`。两种存储根不能互换，也不与 daemon 的历史和 socket 共用。
- 升级时先取得独占锁，再删除旧派工单据（含尝试与交付）、模板及尝试级配置快照。仅清理制品或快照记录指向、已登记且没有其他引用的目录，不扫描删除无主目录，不跟随符号链接或跨挂载点。清理失败时拒绝启动，保留原元数据以便重试。
- 业务库升级不向平台导入配置包、定义或尝试。装配业务目录路由时按旧配置包和执行器制品的目录引用排除存量平台文件。无法确认旧记录归属时启动失败。普通业务目录仍按自身的读写状态提供服务。
- 缺少令牌、地址无效、daemon 无法执行或就绪失败时不报告服务可用。诊断不输出令牌。

### 独占与关闭

#### 验收

- 启用 Flow 时，启动前已有 `runtime.sock` 则拒绝启动，不收养已有 daemon，不删除或替换 socket。
- 子进程已启动但服务装配失败时，回收本次启动的进程。收到 `SIGTERM` 或 `SIGINT` 时停止 HTTP 并等待自己的 daemon 退出，正常退出不遗留 socket 或受管命令。
- 启用 Flow 时，再次启动使用新的 daemon 进程，沿用原数据目录可以读回已保存的配置、包和历史。
