---
parent: ../../SPEC.md
references:
  - ./CONTRACT.md
---

# sandbox-runtime

## 功能意图

sandbox-runtime 定义沙箱的运行时交付物，包含两部分：一是沙箱容器镜像（Dockerfile），定义镜像内包含的环境（系统工具链、git、agent CLI、code-server、Chromium、noVNC、应用预览栈）；二是平台 runtime bundle，在运行中注入沙箱的相关服务与配置（终端、ACP backend、CDP、noVNC、preview 等通道服务与启动配置），bundle 与镜像分离发布，通道服务随 bundle 迭代而无需重建镜像。

由 gateway 的 docker 驱动供应为容器；channel 的连接对端服务（ACP backend、终端、CDP、noVNC、preview）随 bundle 注入沙箱并在镜像环境中运行。

## 关键功能与验收

### 沙箱镜像

提供 Dockerfile 与环境定义：基础系统、git、agent CLI、通道服务运行环境（code-server、Chromium、noVNC、预览栈）。镜像只提供环境，业务逻辑由 kernel 经运行面契约完成。镜像契约（入口路径、目录约定、版本标记）见 CONTRACT.md。

#### 验收

- 镜像构建成功，容器启动后 bootstrap 入口可执行并汇报环境就绪。
- 镜像内容影响契约时（入口、目录、CLI 版本），版本标记随之提升。

### runtime bundle

bundle 是注入沙箱的服务与配置包：通道服务的启动脚本与配置、目录初始化、环境装配。bundle 与镜像的版本契约独立演进：镜像提供环境基线，bundle 提供服务与配置，二者经版本标记互相校验兼容性。

#### 验收

- bundle 注入后，容器内通道服务（首版至少 exec 通道与 ACP backend）可启动并被 channel 连接。
- bundle 内容变更不需要重建镜像；镜像内容变更时按版本契约提示重建。

### 目录约定

镜像内固定工作区根目录与产物目录路径，kernel、bundle 与镜像以该约定交换输入输出。

#### 验收

- kernel 写入输入目录后，容器内对应路径可读到内容。
- 容器内产物目录的文件可被 kernel 读出。
