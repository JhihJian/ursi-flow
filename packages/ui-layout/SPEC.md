---
parent: ../../SPEC.md
---

# 页面布局

## 功能意图

`@ursi/ui-layout` 为 React 19 宿主提供通用页面骨架。宿主提供页面头部、主内容和可选辅助内容，组件负责语义结构、键盘导航与响应式排列。

## 关键功能与验收

### 内容插槽与键盘导航

`PageFrame` 接收 `header: ReactNode`、`main: ReactNode`、`aside?: ReactNode` 和 `asidePlacement?: 'right' | 'below'`。默认位置为 `right`。

#### 验收

- 即使传入空值，页面仍有 `header` 与 `main` 元素。省略 `aside` 或传入空字符串、纯空白、布尔值、空数组或空片段时，不生成 `aside` 元素，也不预留侧栏位置。数值 `0` 正常渲染。
- 在页面内按 Tab 可看到跳转到主内容的链接。按 Enter 后焦点进入该组件的 `main`，继续按 Tab 从主内容开始，跳过头部的可聚焦元素。

### 响应式排列与宿主覆盖

双列宽度规则源于 DeepSeek Harness 的 `packages/client/ui-layout/src/client/columns.ts`（提交 `4b399c39a6`）。空间减少时优先缩窄辅助栏，达到最小宽度后改为上下排列。

#### 验收

- 视口宽度至少为 `768px`、组件内能容纳两列及间距、且位置为 `right` 时，`aside` 与 `main` 同行，位于主内容右侧（从左至右排版）。视口更窄、组件内空间不足或位置为 `below` 时，`aside` 在 `main` 下方占整行。切换布局时，DOM 顺序始终为 `header`、`main`、`aside`。
- 默认间距为 `24px`、主列最小宽度为 `400px`、辅助列最小宽度为 `300px`。辅助列的首选宽度和上限分别为组件宽度的 `45%` 和 `70%`。例如，组件可用宽度为 `1200px` 时辅助列宽 `540px`，缩至 `768px` 时辅助列宽 `344px`。
- 宿主在祖先元素或组件根节点上设置 `--ursi-page-frame-gap`、`--ursi-page-frame-main-min`、`--ursi-page-frame-aside-min`、`--ursi-page-frame-aside-preferred` 或 `--ursi-page-frame-aside-max` 后，对应的间距或列宽按覆盖值计算。间距与最小列宽使用长度值，辅助列的首选宽度与上限可使用相对组件宽度的百分比。组件样式只作用于带 `ursi-page-frame` 命名空间的元素。
