---
parent: ../..
references:
  - ../../../apps/ssh-web/SPEC.md
  - ../../../apps/ssh-web/README.md
  - ../../../packages/workspace-shell/MODULE-CONTRACT.md
---

# SSH 终端接入工作区外壳

## 背景与目标

ssh-web 目前是 5193 端口的独立站点：自己的 Rust 服务（8091）、自己的三级面板布局、自己的全局样式。用户要在 shell-web 工作区里同时用 todo、fs、终端，就要在多个窗口间切换。

本次集成把 ssh-web 变成 shell-web 的一栏模块，与 todo、fs、pi-web 并列：终端和文件、待办同屏，右键、搜索、亮暗主题等行为不变。独立入口保留，两种形态共用同一套组件与 store。

不做的边界：

- 不做服务端合并。SSH Rust 服务仍是独立进程，拥有 `~/.ursi/ssh/ssh.db`，不并入宿主后端。
- 不做会话保活。折叠即断开 WS，持久性完全由远端 tmux 承担，与既有边界一致。
- 不做生产网关改造。生产同源反代由部署侧处理，与 todo、fs 同一策略。
- 不发布 selection、不注册 actions。没有其他模块消费 SSH 实体，等出现消费方再做。

## 总体方案

前端按 MODULE-CONTRACT 以 `@ursi/ssh-web/module` 接入，服务端不感知嵌入形态。整条链路是：

```
shell-web 栏（.ssh-embed）
  → module.tsx（createSshModule，注入 apiBaseUrl）
  → vite 代理 rewrite /api/ssh-web/* → 8091 的 /api/*
  → Rust 服务（路由不动，仍是 /api/*）
```

关键决定与理由：

1. **服务端零改动，前缀在代理层 rewrite。** 服务路由保持 `/api/*`，宿主代理把 `/api/ssh-web/*` 重写为 `/api/*` 转发（WS 同样）。这样不用为 WS upgrade 单独处理前缀，独立入口（5193 代理 `/api`）和嵌入入口（代理 rewrite）走同一个后端，也不产生"同一服务双前缀"的运维问题。客户端 `terminalWsUrl` 从注入的 base 推导 WS 地址，不再自行拼 `/api/...`。
2. **store 从模块级单例改为工厂创建。** 现在 `useSshStore` 在 import 时创建并读 localStorage，工厂注入的 key 永远晚于首次读取。改为 `createSshModule` 内部创建 store 与 api client，`apiBaseUrl`、`storageKey` 作为创建参数。约束：一页一个实例（registry 单实例成立），注释写明。
3. **布局从嵌套可拖拽 Group 改为纯 flex。** 现 App.tsx 用 react-resizable-panels 套三级栏，违反契约"不要嵌套可拖拽 Group"。改为 `.ssh-embed` 根下一个 180px 侧栏（上段连接列表、下段选中连接的 tmux 会话，各占一半、各自滚动）加 `flex: 1` 终端区。独立入口用同一组件，外壳只包一层 `height: 100dvh`。`react-resizable-panels` 依赖删除。
4. **折叠即卸载，不保活。** 远端 tmux 会话继续运行，重新展开后点会话重新 attach、屏幕内容完整恢复。这符合"持久性由远端 tmux 承担"的既有边界，也避免为 iframe 式保活引入 `keepMounted` 与 WebGL 上下文驻留。折叠摘要由新增的 `terminalState`（connecting / live / ended / error / closed，卸载落为 closed）驱动。
5. **样式全量作用域化。** 现有 styles.css 的 `:root` 变量、`*` reset、`html/body/#root`、全局隐藏滚动条全部违反契约 §5。拆两份：`module.css` 作用域到 `.ssh-embed`（组件样式加前缀，变量挂根类，`.xterm` 覆盖带前缀），`standalone.css` 仅独立入口导入（全局高度与 reset）。宿主已有 todo-web 提供的同类变量，模块内用 `var(--x, 兜底值)` 取值，不重复定义 `:root`。
6. **浮层与快捷键服从宿主。** ContextMenu 从 `createPortal(document.body)` + `position: fixed` 改为 portal 进 `.ssh-embed` 容器 + `position: absolute`，坐标按 `clientX/Y − 容器 rect 原点` 换算、按容器 rect 钳制（窄栏左翻）；关闭监听仍挂 window（卸载即清理）。Ctrl/Cmd+F 搜索监听从 window 级改到 `.ssh-embed` 容器级，命中时 `preventDefault + stopPropagation`，焦点在模块外时不拦截。删除连接的 `window.prompt` 二次确认改为侧栏内联确认行（输入名称 + 确认/取消），契约禁止原生弹窗。

## 详细改动

### Rust 服务（不动）

`apps/ssh-web/server` 不改代码。前缀重写由代理层完成，服务继续监听 8091、继续托管独立入口的静态页面与 `/api/*`。

### ssh-web/web（主要工作量）

| 文件 | 改动 |
| --- | --- |
| `src/module.tsx`（新增） | `createSshModule({ apiBaseUrl?, storageKey? })`：创建 api client 与 store，返回 `WorkspaceModule`：`id: 'ssh'`、`title: 'SSH'`、`hideHeader: true`、`defaultSize: 560`、`minSize: 420`、`collapsedSize: 32`、`useCollapsedSummary`。不设 `selection`、`actions`。 |
| `src/SshWorkspace.tsx`（新增） | flex 布局容器：180px 合并侧栏（上连接、下 tmux 会话）+ 终端区 `flex: 1`。挂 Ctrl/Cmd+F 容器级监听。ConnectionEditorSheet 改挂模块根，作为 absolute 底部浮层。 |
| `src/App.tsx` | 改薄壳：`<SshWorkspace />` 外包独立入口的全局容器。 |
| `src/api/client.ts` | 构造函数接受 baseUrl（缺省 `/api`）；`terminalWsUrl` 从 base 推导（相对 base 同 host 换协议，绝对 base 解析 URL 换协议）。 |
| `src/store/ssh-store.ts` | 改为工厂创建（`createSshStore(deps)`）；`terminal-light` 键由 storageKey 派生（默认 `ssh.terminal-light`，旧键 `ssh-web.terminal-light` 不迁移，丢一次偏好可接受）；新增 `terminalState` 字段；新增 `requestSearch()`（终端聚焦在非终端区域时触发搜索条打开）。 |
| `src/components/*` | ContextMenu：portal 目标改为容器、fixed→absolute、坐标换算与钳制。ConnectionSidebar：prompt 改内联确认行。TerminalPane：维护 `terminalState`，卸载时落 closed。 |
| `src/styles.css` → 拆分 | `module.css`（作用域到 `.ssh-embed`）+ `standalone.css`（独立入口全局）。`.xterm` 覆盖带 `.ssh-embed` 前缀。 |
| `package.json` | 删 `react-resizable-panels`；`exports` 增加 `./module` 与 `./module.css`。 |

验收补充（嵌入形态）：

- shell-web 出现 SSH 栏，建连、选连接列 tmux 会话、点会话 attach、输入输出、缩放自适应全部可用，行为与独立入口一致。
- 折叠 SSH 栏后远端 tmux 会话保活；重新展开点同一会话，屏幕内容恢复。
- 宿主其他栏（todo、fs、pi-web）不受 SSH 样式、快捷键、浮层影响；SSH 栏内 Ctrl+F 打开终端搜索且不触发浏览器查找。
- 焦点在连接名输入框时 Ctrl+F 仍能打开终端搜索（容器级监听）。
- 折叠摘要显示当前连接、tmux 会话与连接状态。

### shell-web（宿主）

| 文件 | 改动 |
| --- | --- |
| `package.json` | dependencies 加 `"@ursi/ssh-web": "*"`，根目录 `npm install` 建立链接。 |
| `vite.config.ts` | proxy 加 `'/api/ssh-web': { target: env SSH_WEB_API ?? 8091, ws: true, rewrite: 去掉 /ssh-web 段 }`，排在通用 `/api` 之前；`preview` 同。 |
| `src/registry.tsx` | SOURCES 加 `'ssh': '@ursi/ssh-web/module'`；BASE_MODULES 加 `createSshModule({ apiBaseUrl: '/api/ssh-web' })`；导入 `@ursi/ssh-web/module.css`。 |

栏序采用 todo、fs、ssh、pi-web：终端是文件操作的下游，放在 fs 之后、pi-web 之前。

### 文档

| 文档 | 改动 |
| --- | --- |
| `apps/ssh-web/SPEC.md` | 「服务与接口」加代理 rewrite 说明；「终端与 tmux 会话」验收中"react-resizable-panels 可拖拽调宽"改为侧栏固定、终端随栏宽自适应；新增「工作区嵌入」小节。 |
| `apps/ssh-web/README.md` | 组成加 module.tsx；运行加嵌入模式启动说明（宿主代理 + SSH_WEB_API 可覆盖）。 |
| `ARCHITECHTURE.md` | SSH 行"russh 建立会话"纠正为系统 OpenSSH `ssh -tt` 子进程；模块关系与设计索引登记本文档。 |

## 实施顺序与验证

1. **宿主代理连通验证（先做，暴露最大风险）**：改 vite.config.ts，起 8091 与 dev:shell-web，用临时脚本验证 `/api/ssh-web/health` 与 WS upgrade 到达后端。WS 经 vite 前缀代理是最大不确定点，理论可行，先实证再铺开。
2. **ssh-web/web 重构**：client 注入 → store 工厂化 → 布局 flex 化 → 样式拆分 → ContextMenu/prompt/terminalState。每步 `npm run typecheck -w @ursi/ssh-web` 与 `npm run build -w @ursi/ssh-web`，独立入口手工过：建连、attach、缩放 fit、Ctrl+F、右键菜单、亮暗切换。
3. **模块接入**：module.tsx + registry + package.json，根目录 `npm install`，`npm run build:shell-web`。手工过嵌入验收清单，重点：窄栏（420px）下 htop 可读、折叠摘要更新、宿主快捷键不受干扰。
4. **文档更新与提交**：按上表更新，中文 commit，达成条件后合并。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| vite ws 代理对 rewrite 后前缀的支持未实证 | 实施第 1 步单独验证；异常时备选方案是服务端 `Router::nest` 双前缀挂载（约 3 行），代理去掉 rewrite。 |
| 窄栏（420px）终端约 30 列，TUI 局促 | 验收用 htop 实测；侧栏可收起不在本期范围，实测不可接受再立项。 |
| storageKey 改名丢一次亮暗偏好 | 已接受的取舍，不做迁移。 |
| ContextMenu 坐标换算遗漏钳制 | 验收清单含窄栏右键菜单不越栏。 |
