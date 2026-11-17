---
parent: ../SPEC.md
references:
  - ./CONTRACT.md
---

# sandbox-image

## 功能意图

sandbox-image 定义沙箱容器镜像：系统工具链、agent CLI、bootstrap 入口与目录约定。它是链条中「Isolated Sandbox」一环的载体，由 gateway 的 docker 驱动供应为容器。镜像只提供环境，业务逻辑（任务下发、产物回收）由 kernel 经运行面契约完成，镜像不含 kernel 代码。

## 关键功能与验收

### 镜像定义

提供 Dockerfile：基础系统、git、agent CLI（首个真实 CLI 在 executor 工作包时定）与 bootstrap 入口脚本。镜像契约（入口路径、目录约定、版本标记）见 CONTRACT.md。

#### 验收

- 镜像构建成功，容器启动后 bootstrap 入口可执行并汇报环境就绪。
- 镜像内容影响契约时（入口、目录、CLI 版本），版本标记随之提升。

### 目录约定

镜像内固定工作区根目录与产物目录路径，kernel 与镜像以该约定交换输入输出。

#### 验收

- kernel 写入输入目录后，容器内对应路径可读到内容。
- 容器内产物目录的文件可被 kernel 读出。
