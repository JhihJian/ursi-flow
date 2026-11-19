# 第三方代码声明

## Grasp

- 项目：https://github.com/cocofhu/grasp
- 来源版本：`b2541df645e159604bf170cec4c9dd761b256d92`
- 复用来源：`/data/github/grasp` 工作副本中的组件、图标和主题定义。
- 原作者：cocofhu
- 许可证：MIT，完整文本见下方。

| 原始文件（Grasp 仓库根目录相对路径） | ursi-flow 文件 | 适配内容 |
| --- | --- | --- |
| `web/src/components/ui/AppModal.vue` | `src/shared/ui/modal.tsx` | 保留焦点约束、循环、恢复、叠层与 Esc 语义，迁移到 Radix Dialog，关闭标签改为中文，保留左侧抽屉位置、背景滚动锁定及顶层事件保护。 |
| `web/src/components/ui/AppTabs.vue` | `src/shared/ui/tabs.tsx` | 保留滑动指示器、禁用反馈和尺寸更新，增加标签页语义及方向键、Home、End 键操作。 |
| `web/src/components/ui/AppSwitch.vue` | `src/shared/ui/switch.tsx` | 复用布尔开关、键盘交互、状态样式与减少动画设置。 |
| `web/src/components/ui/AppButton.vue` | `src/shared/ui/button.tsx` | 保留变体、尺寸、加载与禁用逻辑，默认关闭光晕并使用普通按钮类型。 |
| `web/src/components/ui/AppSpinner.vue` | `src/shared/ui/spinner.tsx` | 复用加载状态，通过本地 Icon 显示。 |
| `web/src/components/ui/Icon.vue` | `src/shared/ui/icon.tsx` | 保留本地可信 SVG 定义的渲染方式，移除 useIconMotion 与复杂交互动画，以 CSS 提供真实加载旋转和减少动画支持。 |
| `web/src/lib/icons/catalog.ts` | `src/shared/icons/catalog.ts` | 复用类型、图标检索及安全回退逻辑。 |
| `web/src/lib/icons/definitions.json` | `src/shared/icons/definitions.json` | 复用全部图标定义。 |
| `web/src/styles/global.css` | `src/app/styles.css` | 适配明暗主题颜色及动画时间 tokens，默认亮色，调整部分状态与文本对比度，新增业务表格、表单及响应式布局样式。 |
| `web/tailwind.config.js` | `tailwind.config.js` | 适配语义颜色映射为 CSS RGB 变量，保留本项目字体和构建扫描范围，并增加 shadcn 语义 token 映射。 |

`AppShell.tsx`、`theme.ts`、`shell-sidebar.tsx`、`page-header.tsx`、`resource-state.tsx`、`status-pill.tsx` 为 ursi-flow 的应用装配与公共展示组件。视觉使用上述 Grasp 主题与控件，品牌保留 ursi-flow。

### MIT 许可证原文

```text
MIT License

Copyright (c) 2026 cocofhu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## shadcn/ui

- 项目：https://github.com/shadcn-ui/ui
- 许可证：MIT
- 复用方式：`src/shared/ui` 下的 `badge`、`button`、`input`、`label`、`select`、`sheet`、`switch`、`tabs`、`textarea` 以及 `modal` 的对话框结构取自 shadcn/ui 注册表（new-york 风格）源码；`status-pill` 基于其中的 `badge` 封装。以上组件均按本项目的 CSS 变量、字号与间距调整。组件保留 class-variance-authority 变体写法，shadcn 语义 token（`--background`、`--primary` 等）在 `src/app/styles.css` 中映射到既有 `--c-*` 调色板；`--accent` 使用中性 hover 底色，品牌紫仍由 `--c-accent` 表达。

## 对话模块参考

- 项目：https://github.com/shadcn-ui/chatbot-template
- 许可证：MIT
- 复用方式：仅参考会话消息流、流式状态与输入框的布局和交互组织方式。ursi-flow 的对话模块按本项目模块结构重写，使用自有 DTO、Zustand store、NDJSON 流解析与模拟后端，未引入 Next.js、AI SDK 或模板的独立页面外壳。

## 运行时依赖

以下依赖通过 npm 安装，许可证文本随包分发于 `node_modules`，此处记录名称、用途与许可证类型。

| 依赖 | 用途 | 许可证 |
| --- | --- | --- |
| `react`、`react-dom` | UI 运行时 | MIT |
| `react-router` | 客户端路由与数据路由 | MIT |
| `zustand` | 应用级状态（主题、反馈、对话会话） | MIT |
| `@radix-ui/react-*` | 对话框、标签页、开关、下拉菜单、提示等无障碍基元 | MIT |
| `class-variance-authority` | 组件变体定义 | Apache-2.0 |
| `clsx`、`tailwind-merge` | 类名组合与冲突合并 | MIT |
| `tailwindcss`、`tailwindcss-animate` | 原子化样式与动画插件 | MIT |
| `marked` | Markdown 解析 | MIT |
| `dompurify` | HTML 净化 | MPL-2.0 或 Apache-2.0（双许可） |
