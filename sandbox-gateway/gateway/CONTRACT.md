# gateway 契约

kernel 与 gateway 通过版本化 REST 契约耦合，不共享类型。本文件是契约的事实来源，两侧实现各自定义结构体，用 golden JSON fixture 测试锁定。

## C1 控制面（kernel → gateway REST）

对齐 grasp gateway v1：

- `POST /api/v1/sandboxes`：创建，受理返回（异步到 running）
- `GET /api/v1/sandboxes/{id}`：查询状态与端点
- `GET /api/v1/sandboxes?label=k:v`：列表（标签 AND 过滤）
- `POST /api/v1/sandboxes/{id}/start|stop`：恢复/停止
- `POST /api/v1/sandboxes/{id}/reinstall`：重建（`preserveData` 默认 true 保数据卷）
- `DELETE /api/v1/sandboxes/{id}`：删除
- `GET /api/v1/sandboxes/{id}/logs?tail=`：日志（非流式）
- `GET /api/v1/sandboxes/{id}/host/{port}`：public 端口的宿主地址
- `GET /api/v1/sandboxes/{id}/ports/{port}`：internal 端口发布（按需）
- `GET /api/v1/capabilities`、`GET /api/v2/info`：gateway 描述（driver、默认镜像、profile、端口表、能力）
- `GET /healthz`：健康检查

鉴权：Bearer API key（kernel 与 gateway 共享密钥），本地匿名豁免可配置。错误体结构、状态码语义与 grasp v1 一致（404/409/501）。

生命周期状态：`pulling → creating → running ⇄ stopped → stopping → deleting`，异常进入 `error`。

## C2 传输面（tunnel，可选）

客户端经 gateway 鉴权后按「沙箱 ID + 客户端口」建立 TCP/WebSocket 传输（ursi-tcp-v1 帧协议），gateway 校验记录与驱动实际状态后解析当前端点并中继字节流。语义：

- `GET /api/v2/sandboxes/{id}/connect/{guestPort}`，`Upgrade: websocket`，子协议 `ursi-tcp-v1`
- 不提供任意 host/URL 参数；未知沙箱/端口 404，升级前不可达 502，错误子协议 400
- 二进制帧承载有序 TCP 字节，帧上限 64 KiB；文本 `eof` 表示半关闭；Ping/Pong 保活
- 传输面鉴权独立于控制面：未配置 API key 时传输面禁用（503）

## C3 运行面（kernel → sandbox，经 C1 端点发现 + C2 隧道）

kernel 从控制面拿到沙箱端点后直连沙箱内 session-service 执行数据面操作：agent 会话（ACP）、进程执行（exec）、输入写入、输出与产物读取。internal 端口经 C2 tunnel 访问，public 端口可直连。传输实现（首版 SSH 经 tunnel 或 session-service exec 端点）在 channel 工作包定稿；本文件锁定「数据面不经 gateway 中转业务语义，gateway 只做端点解析与字节中继」的边界。

## 端口分级

- public 端口：驱动发布到宿主（bindIP:ephemeral），地址经 C1 查询返回，可直连。
- internal 端口：不发布宿主，仅容器网络可达，经 C2 tunnel 访问（CDP/noVNC 类）。

## 契约测试

- golden JSON：控制面请求/响应体两侧各持 fixture 副本，任一侧结构变更必须同步修改两侧 fixture（测试失败即提示契约漂移）。
- fake 驱动记录创建规格（env、ports、labels），作为 env 与端口透传语义的断言基准。
- 镜像契约：sandbox-gateway/runtime 提供的镜像必须含 bootstrap 入口与 process-supervisor；镜像内容变更需要提升镜像版本标记（IMAGE_LEVEL）。
