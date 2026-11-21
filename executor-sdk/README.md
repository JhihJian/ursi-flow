# 执行器服务端 SDK

`ursi-executor-sdk` 为 Node.js 22.19+ 提供执行器 MCP stdio 服务。包包含 ESM 实现和 TypeScript 类型，不依赖流程引擎。在本目录运行 `npm ci && npm test`。运行 `npm pack` 得到安装包，消费项目可用 `npm install /path/to/ursi-executor-sdk-0.1.0.tgz` 安装。

## 接入任务后端

```js
import { serveExecutor } from 'ursi-executor-sdk';
import { jobs } from './jobs.js'; // 自己的持久任务后端

await serveExecutor({
  name: 'report-executor', version: '1.0.0',
  runConfigSchema: {
    type: 'object', additionalProperties: false,
    properties: { format: { enum: ['text', 'markdown'] } },
  },
  start: request => jobs.start(request),
  inspect: ({ attemptId }) => jobs.inspect(attemptId),
  cancel: ({ attemptId }) => jobs.cancel(attemptId),
});
```

SDK 用同一份 JSON Schema（draft 2020-12）生成 `tools/list` 和校验器。schema 必须接受 `{}`，表示使用后端默认配置。省略 schema 时只接受空对象。每个处理函数返回 `{ attemptId, artifactDirectoryRef, status, backendRunRef? }`，业务错误用 `throw new ExecutorError('conflict')` 等公开错误码表示。stdout 专用于协议。

SDK 校验目录引用与尝试 ID 相符。后端负责安全定位实际目录、持久登记输入和配置、避免重复副作用，并从后端证据确认终态。stdio 进程可在每次调用后退出，不能仅用进程内 Map 保存任务。`server/discover` 和 `tools/list` 都不调用任务处理函数。

`createExecutorServer(options)` 可单独创建消息处理器，`runStdio(input, output, server)` 可连接自定义 Node 流。协议包括 MCP `2026-07-28` 逐请求调用及 `2025-06-18` 初始化会话。新版发现结果在 `result._meta` 中声明 `"ursi/executorProtocol": "1"`。
