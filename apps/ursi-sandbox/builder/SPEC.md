---
parent: ../SPEC.md
depends-on:
  - ../runtime/SPEC.md
  - ../bundles/SPEC.md
references:
  - ./README.md
---

# 沙箱构建器

## 功能意图

从独立沙箱源码构建镜像和可验证的服务归档，使同一 SSH 基线可用于纯 SSH、Pi 和带浏览器的 Pi 环境。

## 关键功能与验收

### 镜像选择与归档装配

构建者选择镜像目标，使用配套输入组合监督配置、服务程序及能力定义。构建输出为镜像或 `runtime-bundle.tar.gz` 与 `runtime-bundle.sha256`。

#### 验收

- SSH 归档无需 Rust 二进制，只声明 sshd 与 SSH 端点。Pi 构建必须提供可执行的 session-service；browser 组合还包含桌面和 IDE 启动文件。
- 相同输入重复构建得到相同归档摘要；端点名称或端口冲突、带实例地址或鉴权字段的定义均拒绝。
- 镜像构建入口从自身位置确定上下文，SSH 阶段独立于 Node/Pi 安装，browser 镜像基于已构建的 Pi 镜像。
