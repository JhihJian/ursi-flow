---
parent: ../../SPEC.md
depends-on:
  - ../shared/SPEC.md
  - ../modules/flows/SPEC.md
  - ../modules/runs/SPEC.md
  - ../modules/config/SPEC.md
  - ../modules/chat/SPEC.md
references:
  - ../../DESIGN.md
---
# 应用装配

## 功能意图

提供响应式工作台、会话入口和四个业务页面分组。

## 关键功能与验收

### 路由和访问

#### 验收

- 根地址进入 Flow 目录；运行、配置和编辑页在原地址登录后打开；对话独立于登录。
- 退出后隐藏服务端数据，未知地址可回到目录，业务路由加载失败可重试。
- 桌面侧栏和移动抽屉均可导航，明暗与主色选择独立保持。弹窗、通知和跳到主内容链接可使用键盘操作。
