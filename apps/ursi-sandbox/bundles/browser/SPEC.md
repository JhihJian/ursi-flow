---
parent: ../SPEC.md
references:
  - ../../runtime/CONTRACT.md
---

# Browser bundle

## 功能意图

在配套镜像中，以 agent 身份运行 Chromium 桌面与 code-server，向工作台增加 IDE 和桌面访问能力。当前构建组合使用 Pi profile 和级别 2 镜像。

## 关键功能与验收

### 桌面与 IDE

启动脚本负责 Xvfb、x11vnc、websockify、Chromium 以及 code-server，监督配置负责进程组启停。

#### 验收

- 归档定义声明 IDE HTTP 8744、桌面 WebSocket 6080；Chromium CDP 9222 只监听回环，未注册为公共端点。
- 镜像就绪要求 Pi 基线和三个附加端口均可用。任一探测失败，健康检查返回非零。
