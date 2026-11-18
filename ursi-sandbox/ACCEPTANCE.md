# 独立工程验收 · 2026-11-18

## 用户场景：门店日结

[复跑说明](examples/daily-close/README.md)。两家门店共六笔样例流水经 SFTP 上传，SSH 在正式沙箱内运行日结程序，下载的 `report.csv` 与手算参考逐字节一致（SHA-256 `322b580eb24990af2c3a4b5e5a6a70392e9b32a8b16d9b454d9245da823db8eb`）。东街店净额 1549 分，西街店净额 -101 分。另一次传入重复流水时，命令退出 1，提示“第 3 行：重复流水号”，没有交付报表。两次均已回收本次容器和卷。本场景验证独立客户端的数据处理，不使用 Flow、ACP 或模型。

## 本轮验证

1. **脱离 Flow 构建**。从集成提交 `263b2c8` 以 `git archive HEAD:ursi-sandbox` 导出到新目录。目录没有 `.git`、`server/`、父工作区或既有 `target/`。在本机已缓存 Cargo 依赖的前提下，`cargo build --offline --locked --bins` 生成 Gateway、session-service 和 Client。使用 `runtime/scripts/build-bundle.sh target/debug/ursi-session-service dist` 生成 bundle，SHA-256 为 `bea85bd9a8277f5e477628919029676ec390b5030ca111c445b2944ff0cd6081`。本轮使用 `CARGO_PROFILE_DEV_DEBUG=0`。
2. **资源生命周期**。在同一导出目录设置 `CARGO_PROFILE_TEST_DEBUG=0`，执行 `cargo test --offline --locked -p ursi-gateway --test docker_acceptance -- --ignored --test-threads=1`。3 项通过、0 忽略，覆盖启停与重建、内部端点隧道、强杀后恢复、删除失败后的资源回收。
3. **公共客户端接入**。正式 Pi 镜像中运行独立 bundle 的 session-service。Flow Runner 和独立 CLI 各自提交请求并确认关闭，在两个新容器中复验。真实 Pi 连接本地确定性模型端点。精确产物摘要、断言、清理结果和复验入口见[联合验收记录](INTEGRATION-ACCEPTANCE.md)。

本轮复用已验收的 Runtime 镜像，不涉及重新构建镜像或真实模型推理；也未从 Flow HTTP API 创建并驱动一个完整工作流。此前包含真实模型修改 Git 仓库、回归测试、取消及资源清理的验证见[历史验收记录](runtime/ACCEPTANCE.md)，其中的 bundle 与本轮不同。
