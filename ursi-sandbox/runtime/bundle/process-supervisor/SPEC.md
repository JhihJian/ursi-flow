---
parent: ../SPEC.md
references:
  - ../../CONTRACT.md
  - ../../AGENT-CONTRACT.md
  - ../../IMAGE-README.md
---

# process-supervisor

## 功能意图

使用镜像中的 supervisord 管理常驻服务，交付启动配置与有界恢复策略。session-service 拥有 Agent 任务，监督器拥有 sshd、session-service 常驻进程。

## 关键功能与验收

### 服务启动与恢复

supervisord 作为 PID 1 启动服务并回收退出子进程。事件监听器对每个常驻服务提供容器生命周期累计三次恢复预算，退避为 5、10、20 秒，调度精度为 5 秒。超过预算、启动失败或控制器异常时关闭 runtime。

#### 验收

- 服务进程存在但 SSH 登录或 session health 未通过时健康检查失败。
- 常驻服务异常退出后按退避恢复，第四次退出导致整个 runtime 停止。
- 服务成功恢复不会重置累计预算，Agent 任务失败不会触发重放。
- 控制器自身发生异常时结束 runtime，监督日志可定位服务与恢复次数。

### 信号与进程回收

Supervisor 接收容器停止信号，先停止 session-service，再停止 sshd 和恢复监听器。服务使用进程组停止，超时后强制终止，session-service 的宽限期为 15 秒，sshd 为 5 秒。

#### 验收

- 发送停止信号后监督器和常驻服务退出，容器正常结束。
- 服务不响应停止信号时，在有限宽限期后被终止。
- 退出的子进程由 PID 1 回收。由 session-service 创建独立进程组的 Agent 子进程由 session-service 负责取消及回收。
- 恢复预算耗尽后容器为 stopped，Gateway 依据容器状态与健康状态判断不可用。
