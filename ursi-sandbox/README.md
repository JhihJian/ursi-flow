# ursi-sandbox

为独立客户端或工作流引擎提供 Docker 执行环境。Gateway 供应资源，Runtime 管理工作区内的 Agent 会话，Client 提供 Rust 库和命令行。设计与责任划分见 [整体架构](DESIGN.md)。

## 从源码构建

在 Linux 上从本目录执行以下命令，不需要 Flow 源码。二进制与镜像需使用兼容的架构和 glibc。

```bash
cargo build --locked --bins
docker build -t ursi-runtime-pi:local runtime/image
runtime/scripts/build-bundle.sh target/debug/ursi-session-service dist
target/debug/ursi-sandbox-client --help
```

发布时分别交付 Gateway、客户端、环境镜像和经 SHA-256 校验的 bundle。部署者提供可供容器下载的 bundle 地址、Docker daemon、私有配置目录和访问身份。不要将模型凭据放入这些产物。

- [Gateway 部署](gateway/README.md)：配置 Docker、SQLite、profile 和端点策略。
- [Runtime 部署](runtime/README.md)：准备镜像和 bundle，配置最小模型身份。
- [Client 使用](client/README.md)：创建沙箱、通过 SSH/SFTP 准备仓库、通过 ACP 执行并关闭会话。
- [本轮验收](ACCEPTANCE.md)：只取本目录构建、真实 Docker 和外部调用方验证的结果及边界。
