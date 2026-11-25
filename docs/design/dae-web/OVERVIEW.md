# dae 路由观察台设计

## 问题

本机 dae 是 eBPF 透明代理，规则生效后浏览器和命令行都看不到「这条连接为什么走了这个出口」。dae v2.1.3 自带 native API，但没有页面，且有两处硬约束：

- API 只允许监听处配置的地址，默认 `127.0.0.1:9527`，局域网浏览器无法直连。
- API 会拒绝带外部 `Origin` 的请求（`403 permission_denied: origin is not allowed`），前端跨端口直连也不行。

因此页面必须与一个同源服务一起发布，由服务端以本机身份访问 API。

## 结构

```
浏览器 <同源> dae-web server <loopback> dae native API (127.0.0.1:9527)
```

- `server/` 用零依赖 Node HTTP：静态托管 `web/dist`，`/api/*` 逐字节转发。转发时删掉 `origin`/`referer`/`cookie`，把 `Host` 改成 dae 地址，SSE 不缓冲、HTTP 超时关闭。
- `web/` 只认 `/api/v1` 相对路径，开发态与生产态行为一致：Vite 代理同样去掉 Origin 头。

不采用另外两条路：把前端交给 dae 的 `ui_dir` 只能 loopback 访问，无法局域网查看；直接开 dae 监听 `0.0.0.0` 会暴露无鉴权的管理 API。

## 页面结构

沿用 todo-web 的骨架：左侧可折叠分区导航，右侧内容区吸顶标题栏 + 滚动表格，底部可拖拽高度的详情面板。

| 分区 | 数据来源 | 主要呈现 |
| --- | --- | --- |
| 概览 | `runtime`、`runtime/outbounds`、`runtime/traffic/history`、`runtime/memory/history` | 六项指标、出口流量曲线、出口计数表、数据面状态 |
| 连接 | `connections?window_seconds=60&sort=window_total` | 会话表，按窗口增量排序 |
| 流历史 | `flows` | 近期流，含已关闭 |
| 规则 | `rules`、`dns/rules` | 流量规则与 DNS 请求/响应规则 |
| DNS | `dns/log`、`dns/cache` | 解析日志与缓存，可删单条或清空 |
| 日志 | `logs`（SSE） | 按级别跟随的输出流 |
| 配置 | `/console/config` 与 dae 的 `config/validate`、`operations/reload` | 带行号的编辑器、诊断列表与备份回滚 |

连接和流的详情面板共用：先展示该条目的元信息，再按需调用 `routing/trace` 回放五元组，把每条候选规则的 `matched`、`not_matched`、`skipped` 列出来。dae 在连接与流记录里把 `rule_id` 置空、`rule_source` 标为 `unknown`，所以「命中哪条规则」只能由回溯回答；回溯成功后用它补齐面板里的规则行。

## 刷新策略

- 单个定时器按当前分区取数，间隔 2/3/5/10 秒可选，可暂停、可手动刷新。切换分区立即取一次。
- 概览顺带取规则，避免指标里出现「0 条流量规则」。
- 日志分区不用轮询，由 SSE 推送；轮询定时器对该分区不做事，避免无意义请求。
- 轮询后用最新快照同步已选中条目，面板不会停在旧数值上。

## 配置写入

dae 的配置写入接口存在，但被两个开关同时门控：`api.config_write` 为真且 `api.secret` 非空（`config/api.go` 的校验规则要求 config_write 必须配 secret）。一旦设了 secret，`AnonymousLoopbackActive` 不再成立，整个 API 都要 Bearer token，现有匿名回环形态作废，本服务与其它本机脚本都要带 token。

因此写配置不走 dae 的写接口，改由本服务编排，dae 只做它不可替代的两件事：

1. `POST /api/v1/config/validate`（`mode: full`）是唯一的权威校验，语法与语义都由 dae 判断，本服务不自己解析配置语法。
2. `POST /api/v1/operations/reload` 是唯一让新配置生效的方式，热加载不断已有连接。

文件写入由服务端以 `sudo -n tee` 完成，写前备份、reload 失败自动回滚并再加载一次。这样 dae 的认证模型不变，写权限仍然收敛在「本机 + sudo」这一层，而不是「任何能连 9527 的进程」。

边界取舍：

- 只对回环来源开放。配置里可能有节点凭据，局域网不该看到原文。
- 保存带 `expectedSha256`，与 dae 上报的 `content_sha256` 不一致直接拒绝，避免用旧快照覆盖别处的改动。
- dae 报告 `secrets_redacted` 时禁止保存，否则会把掩码写回文件。
- 只编辑主配置源，`include` 引入的文件不在页面内处理。

## 写操作

关闭连接、删除缓存、清空缓存会改变 dae 状态。服务端按来源决定：回环地址放行，其它来源返回 `read_only`，前端把错误显示在面板或页内。`routing/trace` 只看不改，任何来源都放行。

这样局域网可以看全量观测视图，而破坏性操作留在我自己的浏览器上。

## 取舍

- 不引入图表库与 UI 框架：一条折线用内联 SVG，表格与状态筛选复用 todo-web 的样式变量与组件形态，构建产物 315 KB。
- 不做历史落盘：dae 的连接与流只存在内存，落盘需要一个采集器与存储，超出「看当前状态」的范围；需要长期留存时另建采集服务，页面再消费它。
- 不复制 dae 的数据契约：dae API 处于 draft，字段以 `/api/v1/capabilities` 和实测为准，服务端只做转发，字段变化时改前端类型即可。
