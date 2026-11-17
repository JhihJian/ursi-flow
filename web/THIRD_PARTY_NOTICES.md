# 第三方代码声明

## Grasp

- 项目：https://github.com/cocofhu/grasp
- 来源版本：`b2541df645e159604bf170cec4c9dd761b256d92`
- 本次复用来源：本地 `/data/github/grasp` 工作副本。以下组件与图标文件在完整读取后复制或适配。
- 原作者：cocofhu
- 许可证：MIT，完整文本见下方。

| 原始文件（Grasp 仓库根目录相对路径） | ursi-flow 文件 | 适配内容 |
| --- | --- | --- |
| `web/src/components/ui/AppModal.vue` | `src/shared/ui/AppModal.vue` | 保留焦点筛选、循环、恢复、叠层与过渡实现。默认启用焦点管理和 Esc，关闭标签改为中文，增加左侧抽屉位置、背景滚动锁定及顶层事件保护。 |
| `web/src/components/ui/AppTabs.vue` | `src/shared/ui/AppTabs.vue` | 保留滑动指示器、禁用反馈和尺寸更新，增加标签页语义及方向键、Home、End 键操作。 |
| `web/src/components/ui/AppSwitch.vue` | `src/shared/ui/AppSwitch.vue` | 原样复用布尔开关、键盘交互、状态样式与减少动画设置。 |
| `web/src/components/ui/AppButton.vue` | `src/shared/ui/AppButton.vue` | 保留变体、尺寸、加载与禁用逻辑，以 CSS hover 替换 hover-ink 指令，默认关闭光晕并使用普通按钮类型。 |
| `web/src/components/ui/AppSpinner.vue` | `src/shared/ui/AppSpinner.vue` | 原样复用，通过本地 Icon 显示加载状态。 |
| `web/src/components/ui/Icon.vue` | `src/shared/ui/Icon.vue` | 保留本地可信 SVG 定义的渲染方式，移除 useIconMotion 与复杂交互动画，以 CSS 提供真实加载旋转和减少动画支持。 |
| `web/src/lib/icons/catalog.ts` | `src/shared/icons/catalog.ts` | 原样复制类型、图标检索及安全回退逻辑。 |
| `web/src/lib/icons/definitions.json` | `src/shared/icons/definitions.json` | 原样复制全部图标定义。 |
| `web/src/styles/global.css` | `src/app/styles.css` | 适配明暗主题颜色及动画时间 tokens，默认亮色，调整部分状态与文本对比度，新增业务表格、表单及响应式布局样式。 |
| `web/tailwind.config.js` | `tailwind.config.js` | 适配语义颜色映射为 CSS RGB 变量，保留本项目字体和构建扫描范围。 |

`AppShell.vue`、`theme.ts`、`ShellSidebar.vue`、`PageHeader.vue`、`ResourceState.vue`、`StatusPill.vue` 为 ursi-flow 的应用装配与公共展示组件。视觉使用上述 Grasp 主题与控件，品牌保留 ursi-flow。

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
