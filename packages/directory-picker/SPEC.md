---
parent: ../../SPEC.md
---

# 目录选择组件

## 功能意图

`@ursi/directory-picker` 给各应用的「输入服务器目录路径」场景一个统一的浏览组件，替代手打绝对路径。包只含 UI 与交互，不含数据获取：数据由调用方注入一个 `listDir(target)` 函数，服务端各自的浏览路由负责位置解析、realpath 规范化、目录校验与排序。定位与 `@ursi/workspace-shell` 相同：共享 UI 包，不是业务模块。

位置的身份是 URI，与 `@ursi/location` 一致：`file:///abs` 是本机，`ssh://<设备名>/abs` 是远程设备。组件只经 `@ursi/location` 从一个位置派生相邻位置（进子目录、回上级、面包屑），不自己拼路径字符串。

参考过 orca（stablyai/orca）的 host-path-browser；只取其交互骨架（面包屑、路径/过滤二合一、就地渲染），不搬它的防抖路径预览、win32 盘符与双击选中机制。

## 关键功能与验收

### 目录浏览主体（DirBrowser）

面包屑（设备 / 上级 / 主目录 / 逐级路径）+ 路径/过滤二合一输入 + 子目录列表 + 确认按钮。只列子目录：组件面向「选目录」，不浏览文件。

#### 验收

- 挂载即加载初始位置，展示服务端规范化后的位置作为锚点（`~` 已展开）；底部提示与条目悬浮显示完整 URI。
- 面包屑由 `crumbs(location)` 生成，第一级按 scheme 显示：`file` 显示「本机」（在设备根时即高亮），`ssh` 显示设备名；其后逐段可点击跳转。
- 「~」在本机回主目录，在远程设备跳该设备根；「/」跳当前设备根；进入子目录用 `childOf`，回上一级用 `listing.parent`，三者都保留 scheme 与设备。
- 传入 `devices` 时面包屑最左侧多一个设备下拉，本机固定第一项，切换即跳目标设备根。
- 输入含 `://`、`/`（或 `~`、`.`、`..`）回车当路径导航；输入纯文字时实时过滤当前列表，回车进入唯一命中。
- ↑↓ 在列表内移动高亮，回车进入高亮目录；Esc 先清过滤、再交给 onCancel。IME 组合期不抢按键；Enter/Escape stopPropagation，不抢占宿主快捷键。
- 单击子目录进入；列表顺序由服务端决定，组件不重排（fs-web 目录优先、pi-web 会话数优先都是领域决策）。
- 错误就地显示且不丢当前列表；加载中禁用确认按钮，避免选中未加载完的目录。
- 并发导航只认最后一次（generation 计数），卸载后在途回包不触发 setState。
- `note` 字段原样展示条目标注（如「3 个会话」）；`suggestions` 渲染为快捷目录。

### 数据契约

调用方注入 `listDir(target) => Promise<{ location, parent, entries }>`。`target` 是位置 URI；不含 `://` 的本机简写（如 `~`、`/abs`）组件不解析，原样透传给 `listDir`，由服务端展开。`location` 是服务端规范化后的位置，是组件的导航与提交锚点，`parent` 在设备根为 `null`。`onSelect` 回传的是 URI。

设备切换由 `devices` 注入，组件不发现设备。组件不发请求、不缓存，样式进 `.dp` 容器作用域（无全局选择器、无 position:fixed），零第三方运行时依赖（React 为 peer），对 `@ursi/location` 只有纯函数依赖。

#### 验收

- 任意实现 `listDir` 契约的宿主都能直接使用组件，不需要适配层。
- 组件测试覆盖竞态、卸载失效、Esc 两段语义、IME 守卫、过滤与导航、远程位置与设备切换（`npm run test:directory-picker`）。

## 归属与边界

- 父级：[ursi-flow](../../SPEC.md)。包只依赖 `@ursi/location`（位置契约纯函数），模块接入经各自的 api 封装注入 `listDir`，不产生跨模块 import。
- 组件说 URI。`listDir` 收到的目标里，`~` 这类本机简写与位置 URI 混在一起：组件自己产生的导航（进子目录、回上级、面包屑、设备切换）都是 URI，只有本机的「~」按钮透传简写。服务端认不认 URI 由各应用自己决定。
- 浏览路由归各应用服务端所有：fs-web 是 `GET /api/fs-web/browse`（任意本机目录），pi-web 是 `GET /api/homes/browse`（任意本机目录）与 `GET /api/sessions/browse`（带会话计数）。组件不规定服务端形态。
- flow-web、todo-web 后续接入时按同一契约添加各自浏览路由。
