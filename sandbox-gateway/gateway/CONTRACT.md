# gateway 契约

kernel 与 gateway 通过两份版本化 REST 契约耦合，不共享类型。本文件是契约的事实来源，两侧实现各自定义结构体，用 golden JSON fixture 测试锁定。

## C1 控制面（kernel → gateway REST）

对齐 grasp gateway v1：

- `POST /api/v1/sandboxes`：创建，受理返回（异步到 running）
- `GET /api/v1/sandboxes/{id}`：查询状态与端点
- `GET /api/v1/sandboxes?label=k:v`：列表（标签 AND 过滤）
- `POST /api/v1/sandboxes/{id}/start|stop`：恢复/停止
- `DELETE /api/v1/sandboxes/{id}`：删除
- `GET /api/v1/sandboxes/{id}/logs?tail=`：日志（非流式）
- `GET /healthz`：健康检查

鉴权：Bearer API key（kernel 与 gateway 共享密钥）。错误体结构、状态码语义与 grasp v1 一致（404/409/501）。

生命周期状态：`pulling → creating → running ⇄ stopped → stopping → deleting`，异常进入 `error`。

## C2 运行面（kernel → sandbox 直连，端点经控制面发现）

kernel 从控制面拿到沙箱暴露端点后直连沙箱执行数据面操作：进程执行（exec）、输入文件写入、输出与产物读取、日志流。该契约的传输实现（首版 SSH 或 docker exec 语义的 HTTP 封装）在 executor 工作包时定稿；本文件锁定的是「kernel 不经 gateway 中转数据面流量」这一边界，与 grasp 的 gateway 定位一致。

## 契约测试

- golden JSON：控制面请求/响应体两侧各持 fixture 副本，任一侧结构变更必须同步修改两侧 fixture（测试失败即提示契约漂移）。
- fake 驱动记录创建规格（env、ports、labels），作为 env 与端口透传语义的断言基准。
- 镜像契约：sandbox-gateway/runtime 提供的镜像必须含 agent CLI 与 bootstrap 入口；镜像内容变更需要提升镜像版本标记。
