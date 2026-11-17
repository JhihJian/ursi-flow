---
parent: ../../SPEC.md
references:
  - ./CONTRACT.md
---

# sandbox-gateway/runtime

## 功能意图

sandbox-gateway/runtime 定义沙箱的运行时交付物，包含两部分：一是沙箱容器镜像（Dockerfile），定义镜像内包含的环境；二是平台 runtime bundle，在运行中注入沙箱的相关服务与配置。bundle 与镜像分离发布，通道服务随 bundle 迭代而无需重建镜像。

bundle 内含两类常驻组件：

- `session-service`：会话服务，承载 agent ACP 会话、终端与 code-server 会话、CDP、noVNC、应用预览的会话生命周期与接入点，是 channel 各通道连接的对端服务
- `process-supervisor`：进程监督器，负责沙箱内服务进程的启动、保活、退出上报与优雅停止，bootstrap 完成后由它接管服务进程

由 gateway 的 docker 驱动供应为容器；channel 的连接对端服务随 bundle 注入并在镜像环境中运行。

## 关键功能与验收

### 沙箱镜像

提供 Dockerfile 与环境定义：基础系统、git、agent CLI、通道服务运行环境（code-server、Chromium、noVNC、预览栈）、process-supervisor 运行环境。镜像只提供环境，业务逻辑由 kernel 经运行面契约完成。镜像契约（入口路径、目录约定、版本标记）见 CONTRACT.md。

#### 验收

- 镜像构建成功，容器启动后 bootstrap 入口可执行：初始化目录、装配 bundle、把服务进程移交 process-supervisor 并汇报就绪。
- 镜像内容影响契约时（入口、目录、CLI 版本），版本标记随之提升。

### runtime bundle

bundle 是注入沙箱的服务与配置包：session-service、process-supervisor、通道服务的启动脚本与配置、目录初始化。bundle 与镜像的版本契约独立演进：镜像提供环境基线，bundle 提供服务与配置，二者经版本标记互相校验兼容性。

#### 验收

- bundle 注入后，process-supervisor 拉起 session-service，容器内通道端口可被 channel 连接。
- bundle 内容变更不需要重建镜像；镜像内容变更时按版本契约提示重建。

### session-service

会话服务：管理 agent ACP 会话（会话创建、prompt 下发、事件流回传）、终端与 code-server 会话、CDP、noVNC、应用预览端口的会话生命周期。会话凭一次性会话 token 鉴权（token 经创建规格注入）。首版实现范围随 channel 阶段定稿：至少 ACP 会话与 exec 通道的会话端点，其余端点留接口。

#### 验收

- 经 channel tunnel 连接 session-service 的 ACP 端点，可创建会话并完成一次 prompt 往返。
- 无效或过期 token 的会话请求被拒绝，错误可区分。
- 会话结束时对端资源被回收，监督器收到进程退出上报。

### process-supervisor

进程监督器：按 bundle 配置启动服务进程，崩溃自动重启（带退避），进程退出事件上报（经约定文件或端口），收到停止指令后优雅终止全部子进程。supervisor 自身退出即容器退出。

#### 验收

- 服务进程崩溃后 supervisor 按退避策略重启，重启事件可被观测。
- 收到停止指令后子进程按依赖顺序优雅退出，容器干净终止。
- supervisor 汇报的就绪状态与 gateway 就绪探测（TCP 探测 session 端口）一致。

### 目录约定

镜像内固定工作区根目录与产物目录路径，kernel、bundle 与镜像以该约定交换输入输出。

#### 验收

- kernel 写入输入目录后，容器内对应路径可读到内容。
- 容器内产物目录的文件可被 kernel 读出。
