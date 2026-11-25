---
parent: ../SPEC.md
depends-on:
  - ../image/SPEC.md
  - ../../bundles/browser/SPEC.md
references:
  - ../README.md
---

# Browser 镜像

## 功能意图

基于 `ursi-runtime-pi:local` 安装真实浏览器、显示栈和 IDE。镜像与 browser 归档配套使用。

## 关键功能与验收

### 级别 2 运行环境

镜像提供 Chromium、Xvfb、x11vnc、websockify 和 code-server；启动脚本与监督配置由 bundle 提供。

#### 验收

- 镜像级别为 2，使用 Pi profile 归档和相同的管理员只读配置。
- 配套归档启动后健康检查要求 SSH、会话服务及浏览器的三个端口可用。浏览器包使用 Linux amd64 归档。
