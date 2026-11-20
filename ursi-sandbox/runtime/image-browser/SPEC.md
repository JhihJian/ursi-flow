---
parent: ../SPEC.md
references:
  - ../CONTRACT.md
  - ../IMAGE-README.md
---

# Browser Runtime 镜像

## 功能意图

基于 `ursi-runtime-pi:local` 交付浏览器工作台所需的真实服务：Chromium、CDP、Xvfb、x11vnc、websockify 和 code-server。镜像只提供程序，browser bundle 提供启动脚本、Supervisor 配置和端点清单。

## 关键功能与验收

### 浏览器服务

- 镜像构建完成后 `/etc/ursi-image-level` 为 2，Chromium 的 CDP 只监听沙箱回环端口 9222，code-server 监听 8744，websockify 监听 6080。
- bundle 启动真实桌面会话并将 Chromium、IDE、CDP 和桌面进程纳入生命周期回收。

#### 验收

- 构建镜像并启动 browser bundle 后，三个服务均能从容器内实际建立连接。
- Docker HEALTHCHECK 检查三个浏览器端口，任一端点不可用时不报告健康。
- Gateway 从管理员注册表为该镜像生成 `ide`、`desktop` 逻辑端点。Web 使用已认证 SSH 访问沙箱内部 CDP，CDP 不注册为 Gateway 端点。

### 就绪与边界

- 任一浏览器服务不可用时，端点不进入 ready，浏览器页面只能通过服务端受控适配器访问。

#### 验收

- 杀死任一浏览器服务后，健康检查或端点 readiness 在下一次对账中失败，且浏览器页面不能获得未就绪端点。
