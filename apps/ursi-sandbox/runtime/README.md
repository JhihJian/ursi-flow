# 通用启动支持

`runtime/` 提供镜像共用的 bootstrap、SSH 配置和健康检查，以及随归档交付的 supervisord 基础配置和恢复控制器。镜像与归档分别构建，按 `manifest.profile` 和最低镜像级别配对。构建命令、只读配置挂载与运行示例见 [Builder](../builder/README.md)。

| 镜像 | 启动所需配置 | 就绪检查 |
| --- | --- | --- |
| SSH | `authorized_keys` | 恢复控制器运行、受限密钥实际 SSH 登录 |
| Pi | SSH 配置、`session-token`、`session.json`、`pi/models.json` | SSH 加 session-service `/healthz` |
| Browser | 同 Pi；配套归档含 browser bundle | Pi 加 IDE、CDP、桌面端口 |

镜像固定自己的 profile 检查。bootstrap 在安装前验证只读配置、归档摘要、路径和逐文件清单，使用 `/opt/ursi/runtime/<sha256>` 作为不可变安装位置。工作区位于单独的 `/ursi/workspace` 卷。服务的端点是否开放由 Gateway 注册表决定。

[运行契约](CONTRACT.md)描述装配与权限；[Pi Agent](../bundles/pi-agent/README.md)描述 ACP 和真实模型验收；[Browser](../bundles/browser/SPEC.md)描述桌面与 IDE。
