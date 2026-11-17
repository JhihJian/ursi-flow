# sandbox-runtime 契约

镜像与 runtime bundle 的边界约定，gateway 契约（../gateway/CONTRACT.md）的镜像与注入部分在此展开。

## 镜像

- bootstrap 入口：`/ursi/bootstrap`，容器启动即执行，完成目录初始化并汇报就绪。
- 环境基线：git、agent CLI（首个真实 CLI 在 adapter 工作包时定稿）、code-server、Chromium、noVNC、应用预览栈。
- 凭据：仅经容器环境变量注入（创建规格的 env），不落盘明文。
- 版本标记：镜像内容影响契约时提升 `IMAGE_LEVEL` 文件内容（整数 +1），gateway 创建时透传校验。

## runtime bundle

- bundle 为注入沙箱的服务与配置包：通道服务启动脚本（ACP backend、终端、CDP、noVNC、preview）与配置、目录初始化。
- bundle 版本独立于镜像版本；gateway 创建沙箱时下发 bundle，容器启动时按 bundle 装配服务。
- bundle 内服务监听端口与 channel 的通道清单（见 channel 侧契约）一一对应。

## 目录约定

- 工作区根：`/ursi/workspace/<run-id>/`，每次运行独立目录。
- 输入目录：`/ursi/workspace/<run-id>/input/`，kernel 在节点执行前写入。
- 产物目录：`/ursi/workspace/<run-id>/output/`，节点执行后 kernel 读出。

镜像不含 agent 之外的业务逻辑；agent CLI 选型与版本随 adapter 工作包定稿后更新本文件。
