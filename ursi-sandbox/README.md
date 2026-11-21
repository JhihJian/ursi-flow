# ursi-sandbox

为独立客户端或工作流引擎提供 Docker 执行环境。Gateway 管理沙箱和端点，catalog 校验 bundle 注册表，builder 构建镜像与服务归档。Pi 通过普通 ACP 端点提供会话，通用客户端可独立于 ACP 构建。可选的 Observer 在宿主机记录指定沙箱的网络报文。设计与责任划分见 [整体架构](DESIGN.md)。

主验收场景是[用 ursi-sandbox-client 开发 Hello World 页面](examples/hello-html/README.md)：创建沙箱，通过 SSH 编写 HTML，通过 SFTP 下载并用浏览器打开。验收不调用 Python 脚本，不需要模型密钥。此前的[发布工具检查](examples/release-review/README.md)和[门店日结](examples/daily-close/README.md)作为历史示例保留。

## 从源码构建

在 Linux 上从本目录执行以下命令，不需要 Flow 源码。二进制与镜像需使用兼容的架构和 glibc。

```bash
# 仅 SSH/SFTP，无需 Pi 或模型配置
builder/build-image.sh ssh
builder/scripts/build-bundle.sh --ssh-only dist/ssh
cargo build --locked -p ursi-sandbox-client --no-default-features

# 增加 Pi 会话服务
cargo build --locked --bins
builder/build-image.sh pi
builder/scripts/build-bundle.sh target/debug/ursi-session-service dist
target/debug/ursi-sandbox-client --help
```

发布时分别交付 Gateway、客户端、环境镜像和经 SHA-256 校验的 bundle。部署者提供可供容器下载的 bundle 地址、Docker daemon、私有配置目录和访问身份。不要将模型凭据放入这些产物。

- [沙箱资源控制台](web/README.md)：独立预览或连接 Gateway，查看实例、端点与日志。
- [Gateway 部署](gateway/README.md)：配置 Docker、SQLite、profile 和端点策略。
- [Observer 使用说明](observer/README.md)：与 Gateway 一对一配对，经鉴权 API 启停观测、查看丢包计数并下载 PCAP。Observer 尚未正式部署。
- [构建器](builder/README.md)和[启动契约](runtime/CONTRACT.md)：选择服务组合并准备对应的运行配置。
- [Client 使用](client/README.md)：创建沙箱、通过 SSH/SFTP 准备仓库、通过 ACP 执行并关闭会话。
- [本轮验收](ACCEPTANCE.md)：只取本目录构建、真实 Docker 和外部调用方验证的结果及边界。
