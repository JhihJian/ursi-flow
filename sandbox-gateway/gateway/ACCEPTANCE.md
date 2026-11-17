# Gateway 独立验收

## 结论与范围

2026-11-17，在本机 Docker 29.1.4、Rust 1.97.1 环境完成 Gateway 独立验收。被测对象为 `ursi-gateway` 独立二进制、真实 Docker 驱动、SQLite 生命周期状态与 TCP over WebSocket 隧道。验收不启动项目 server，不使用真实 Agent CLI，也不以 fake 替代 Docker 资源验证。

Runtime 的正式镜像、ACP session-service、Agent CLI Adapter、Kubernetes/E2B 驱动、远程 Docker daemon、生产 TLS 与多租户均不属于本次验收范围。测试镜像是独立网关夹具，不代表 Runtime 已完成。

## 工作包与独立性

- 驱动工作包：Docker 资源适配、归属校验、数据卷和故障测试。
- 接入与隧道工作包：鉴权、HTTP 语义、WS 升级、半关闭和背压。
- 生命周期工作包：SQLite 意图、代际恢复、调度与独立进程入口。
- 独立验收工作包：另一个 agent 编写黑盒验收并实际启动二进制与容器，发现问题后由实现方修复。
- 最终故障修复并行分为进程监督与存储错误分类两个互不重叠工作包。

独立代码审查发现并已修复：超过 16 个沙箱的调度饥饿、Docker context 变化导致目标漂移、保数据重建缺卷被误建空卷、数据库路径别名绕过锁、额外匿名卷泄漏、worker 故障后 API 继续受理及慢请求阻塞退出。

## 真实 Docker 验收结果

执行命令：

```bash
cargo test -p ursi-gateway --test docker_acceptance -- --ignored --nocapture
```

结果：3 项通过，0 失败，0 跳过，耗时约 32 秒。默认测试命令会忽略这三项，因此单独执行上述命令才构成真实 Docker 验收。

| 用例 | 已验证行为 |
|---|---|
| `docker_lifecycle_security_and_internal_tunnel` | 独立进程创建、健康检查就绪、列表/日志/能力/端点、启停、两种重建、工作区文件保留或销毁、双沙箱隔离、删除后资源归零 |
| 同上 | 缺失/错误 key、非法规格、公开 CDP/noVNC、错误子协议、Origin/query/未知端点均被拒绝；internal 无宿主端口映射；公开端口可访问；100 KB 二进制半关闭后尾包完整 |
| `docker_recovers_create_and_both_rebuild_modes_after_sigkill` | 在容器已创建但未提交就绪时强杀 Gateway；创建、保数据重建及销毁数据重建均接回原容器；新代卷中的文件不被重试删除 |
| `docker_delete_failure_survives_gateway_restart` | 外部容器占卷导致删除失败，Gateway 保留删除意图；强杀重启后占用解除，继续清理至记录和资源消失 |

初次真实运行未通过：Docker 29 返回 `volume <name> not found`，原来的不存在识别未覆盖这一精确格式。修复后加入严格错误匹配回归，混合 daemon 错误仍按故障处理，不误判不存在。

## 模块与进程测试

当前共有 52 项库内测试、3 项非 Docker 进程测试和上述 3 项 Docker 验收。按受影响工作包执行，不要求每次运行整个 workspace。

| 范围 | 数量 | 结果与重点 |
|---|---:|---|
| driver | 27 | 通过，Docker 命令参数、归属、镜像能力、冻结 daemon、缺卷、匿名卷、超时、fake 故障 |
| gateway-api | 4 | 通过，鉴权与参数、协议校验、结构化错误及脱敏 |
| lifecycle（含 store） | 16 | 通过，CAS、幂等墓碑、部分成功恢复、保留意图、33 沙箱轮转、数据库锁、worker 故障和存储错误分类 |
| tunnel | 5 | 通过，双向半关闭、EOF 后行为、非法帧、有界背压及取消 |
| process_config | 1 | 通过，独立进程在监听前拒绝缺失、短或含空白的 key |
| process_shutdown | 2 | 通过，已鉴权慢请求下 SIGTERM 限时退出并释放锁，元数据故障时非零退出和重新启动 |

补充检查：`cargo clippy -p ursi-gateway --all-features --all-targets -- -D warnings` 与 Docker-only 编译通过。规格结构和关系使用 `spec_validate` 校验。

推荐定向命令：

```bash
cargo test -p ursi-gateway --lib driver::
cargo test -p ursi-gateway --lib lifecycle::
cargo test -p ursi-gateway --lib gateway_api::
cargo test -p ursi-gateway --lib tunnel::
cargo test -p ursi-gateway --test process_config
cargo test -p ursi-gateway --test process_shutdown
# 仅复验受影响的真实恢复场景：
cargo test -p ursi-gateway --test docker_acceptance docker_recovers_create_and_both_rebuild_modes_after_sigkill -- --ignored --nocapture
```

## Grasp 参考与差异

参考源码根路径为 `/data/github/grasp/sandbox-gateway/gateway`，以下是源路径而非项目文件链接。

| 参考来源 | 采纳行为 | 本项目差异 |
|---|---|---|
| `internal/driver/docker/docker.go` | 生命周期、端点查询、公开/内部区分 | 命名卷与显式代际、严格标签归属、禁止特权和额外匿名卷、固定本机 daemon |
| `internal/store/store.go` | 状态条件更新与持久化 | 修订号 CAS、独占 DB、创建幂等键墓碑 |
| `internal/service/service.go`、`recovery.go` | 异步受理、冻结规格、启动对账、删除恢复 | 按沙箱互斥、有界轮转、代际固定旧资源清理目标，不直接照搬状态机 |
| `internal/api/connect.go`、`docs/API.md` | 升级前校验、TCP 字节、EOF 半关闭、背压 | 本项目单一 v1 API、`ursi-tcp-v1` 子协议、所有资源接口必须鉴权 |

不承诺与 Grasp 全 API 兼容，验收依据为本项目 [HTTP 与传输契约](CONTRACT.md)。

## 证据与清理

完整三项 Docker 运行日志源路径：`/tmp/ursi-gateway-acceptance-final.log`。每个测试输出其临时日志和 SQLite 目录，临时 key 不落报告。

本次三项运行的 scope：

- `acceptance-3651d892a70b43d28d93dbfffc89d9be`
- `acceptance-33104c9614cc4e9091c4e49569fe9299`
- `acceptance-3f3f0ef394d54d1ca9d80d9fa62439ea`

已使用 Docker 标签查询确认以上 scope 无残留容器、卷。专用镜像 `ursi-gateway-acceptance:local` 保留用于复验。设备实验记录源路径为 `/home/jhihjian/deploy/record/evidence/ursi-gateway-acceptance-20261117.md`。

上述三项真实验收后，进程监督和错误分类进行了定向修复，相关模块及进程测试通过。最新代码又单独复验强杀恢复用例，1 项通过、2 项过滤，耗时约 22 秒。该轮日志源路径为 `/tmp/ursi-gateway-recovery-final.log`，scope 为 `acceptance-5ba03254816542ed962df53ed90075c3`。完整真实主链路不因纯文档整理而重复执行。
