# Pi Web 迁移与集成

## 功能意图

`apps/pi-web` 是上游 pi coding agent 的完整 Web UI，以 git subtree 方式从 fork [`JhihJian/pi-web`](https://github.com/JhihJian/pi-web) 接入。目录内为上游内容，不做任何改造；集成侧的工作全部在本文件与根 `SPEC.md`、`ARCHITECHTURE.md` 中完成。

Pi Web 在进程内启动 AgentSession，与 pi CLI 共享 `~/.pi/agent` 的模型、会话、技能和 MCP 配置，浏览器里完整使用 Pi agent 能力。它接替了已移除的 `pi-executor`（静态会话查看前端 + 独立会话服务）。

## 来源与基线

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/agegr/pi-web |
| fork | https://github.com/JhihJian/pi-web（由维护者维护，锁定版本） |
| 基线 commit | `432366bd510c72ce7b678a6cb1220f9cac1ed56c` |
| 版本 | 0.18.0 |
| pi SDK | 1.6.0（精确固定） |

## 接入方式

git subtree，squash 模式。`apps/pi-web` 是纯上游内容，本仓库不修改其中任何文件；首次合入的提交信息记录 `git-subtree-split`，供后续 `git subtree pull` 识别同步点。

```
git remote add pi-web https://github.com/JhihJian/pi-web
git subtree add --prefix=apps/pi-web pi-web main --squash
```

## 同步上游

维护者在 fork 上合入上游更新并验证后，本仓库执行：

```
git fetch pi-web
git subtree pull --prefix=apps/pi-web pi-web main --squash
```

封装脚本见 `scripts/pi-web-sync.sh`。

## 依赖与工作区

- 独立安装：`apps/pi-web` 自带 `package-lock.json`，在自身目录执行 `npm ci`，不纳入根 npm workspaces。
- 原因：`next.config.ts` 的 `outputFileTracingRoot` 与 `serverExternalPackages`（全部 `@earendil-works/pi-*`、`node-pty`）依赖本目录 `node_modules`；纳入 workspace 或 hoist 到根会导致 `next start` 找不到依赖。
- `.next`、`node_modules` 由 `apps/pi-web/.gitignore` 忽略，不进版本库。

## 端口与启动

- 端口 `30141`（上游默认）。
- 开发：`npm run dev:lan`（`next dev -H 0.0.0.0 -p 30141`）。
- 部署：`npm run build && npm run start:lan`（`next start -H 0.0.0.0 -p 30141`）。
- 运行用户必须是 `jhihjian`，才能读取 `~/.pi/agent` 的模型、凭证、技能与 MCP 配置。

## 安全约束

- 暴露到非回环地址前必须设置长随机 `PI_WEB_PASSWORD`；`proxy.ts` 的 Host 白名单不是访问控制（IP 字面量一律放行），密码是唯一防线。
- 密码走 HTTP 明文，仅限受信网络或 VPN 使用。
- 未认证的 API 请求返回 401，写请求必须同源发起。

## 与 pi-executor 的关系

`pi-executor` 已移除。两者此前是两套独立体系：`pi-executor` 的会话服务用独立状态目录且不加载技能与 MCP；`apps/pi-web` 直接读写 `~/.pi/agent/sessions`。迁移后统一由 `apps/pi-web` 提供浏览器侧 Pi agent 能力，Flow 运行轨迹的会话展示由 Flow Runtime 自行实现，不再依赖 `pi-executor`。

## shell-web 嵌入

`apps/pi-web` 以 iframe 嵌入 shell-web 工作区（`apps/shell-web/src/pi-web-panel/`），pi-web 自身做了三处定向调整，其余保持上游原样：

1. **嵌入白名单**（`next.config.ts`）：主页面响应 `Content-Security-Policy: frame-ancestors 'self' ...`。默认只允许同源嵌入，宿主通过 `PI_WEB_ALLOWED_FRAME_ANCESTORS`（逗号分隔 origin）追加，例如 `PI_WEB_ALLOWED_FRAME_ANCESTORS=http://127.0.0.1:5191,http://192.168.1.135:5191`。
2. **嵌入模式**（`lib/embed.ts` + `AppShell.tsx`）：iframe 地址带 `?embed=1` 时禁用浏览器通知（iframe 权限受限），其余功能不变。
3. **外壳常驻**（`packages/workspace-shell`）：`WorkspaceModule` 新增 `keepMounted`，折叠时用 CSS 隐藏而非卸载 Panel，避免 iframe 重载丢失会话、终端与草稿。

### 启动

```bash
# pi-web（局域网访问需 dev:lan，监听 0.0.0.0:30141）
cd apps/pi-web && npm run dev:lan

# shell-web（Vite 5191）
npm run dev:shell-web
```

iframe 地址按当前窗口 hostname + 端口 30141 推导，`VITE_PI_WEB_URL` 可覆盖完整地址。pi-web 未启动时面板显示离线浮层与重试，每 5 秒探活。

