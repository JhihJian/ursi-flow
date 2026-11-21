---
parent: ../SPEC.md
references:
  - ../docs/EXECUTOR-MCP.md
  - README.md
---

# 执行器服务端 SDK

## 功能意图

让独立 Node.js 程序实现三个任务操作即可提供执行器 MCP 服务。任务生命周期和执行证据由后端持有，SDK 负责通信和协议校验。

## 关键功能与验收

### 发现、校验与执行

#### 验收

- 独立 npm 包提供 ESM 入口及 TypeScript 声明，消费者无需安装流程引擎。
- `server/discover` 自报执行器协议版本，发现结果使用 `ttlMs: 0` 和 `cacheScope: "private"`。现代工具请求不需要初始化，旧式客户端仍可使用协议约定的初始化会话。
- 工具目录中的配置 schema 同时用于启动校验。不合规的输入不调用后端，意外异常和无效返回值只产生公开错误码。
- 独立示例服务在不同 stdio 进程中启动、查回和取消同一任务。
