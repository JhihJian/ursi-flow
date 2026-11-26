# 单机部署方案

## 目标与边界

把仓库里需要长期在线的 Web 应用在 `jhihjian-MACO` 上以 systemd 用户服务常驻，开机自恢复。浏览器对外的地址收敛为三个：工作台入口 `http://<host>:8095`、自带密码的 Pi Web `http://<host>:30141`、dae 路由观察台 `http://<host>:8092`。其余后端只监听回环，由入口代理。

不做容器化、多机编排、镜像发布和产物打包。仓库的既有前提是「可信局域网，应用层不做鉴权」，本方案不改变这个边界，只把暴露面收进一个入口。沙箱平台（需要 Docker 与 Gateway）、chat-web（需要 AI Gateway 密钥）、mcp-web（自带 musl 打包发布路线）不在本方案范围内。

## 关键决定

### 统一入口用 Caddy

工作区各模块都以同源前缀 `/api/...` 访问后端，前缀表本来就写在 `apps/shell-web/vite.config.ts` 的开发代理里。生产侧需要的静态托管、SPA 回退、WebSocket 升级与 SSE 直通，Caddy 一页配置即可覆盖；再写一个 Node 网关等于把代理、升级、回退重复实现一遍。主机上已有 Caddy 2.6.2（`/usr/bin/caddy`）。

代价是路由表存在两份：开发期在 `vite.config.ts`，生产在 `deploy/Caddyfile`。新增模块前缀时两处都要改，这一条写进模块接入检查项。

### 后端收敛到回环，另外保留两个门

- 六个后端只服务入口，绑 `127.0.0.1`。Node 服务都已有 `*_HOST` 变量；两个 Rust 服务把 `0.0.0.0` 写死，需要补 `HOST` 变量（默认值保持 `0.0.0.0`，独立启动行为不变），部署时传 `HOST=127.0.0.1`。
- Pi Web 留在 30141：它是完整的 Next 应用，自带 `PI_WEB_PASSWORD` 登录，工作台按 `hostname:30141` 用 iframe 打开。塞进入口的路径前缀要改 Next 的 basePath，收益不抵成本。
- dae-web 留在 8092：它的配置写操作只认 `req.socket.remoteAddress` 是真实回环对端（`apps/dae-web/server/src/server.ts:38`），经反代后所有来源都变成 `127.0.0.1`，这道限制会失效。它本来也不在工作区里，独立成门没有损失。

### 构建产物留在树内，版本就是 git commit

不建发布目录、不打包产物：部署脚本在 `/data/dev/ursi-flow` 原地构建，systemd 单元指向树内路径，回滚是 `git checkout` 到上一个提交再构建一次。发布期间先停单元再构建，避免旧进程读到半成品静态产物。单机单用户场景下，接受每次发布一到两分钟的中断。

只构建被服务的产物。`shell-web` 的模块导出指向各包的 `src/module.tsx`（见各 `web/package.json` 的 `exports`），构建时直接从源码编译，因此不需要预先构建各模块自己的 `web/dist`；那些页面只在单独打开对应后端端口时才有用，不进入发布流程。

### 数据目录不随发布变动

数据全在用户 home 下（见拓扑表）。发布只替换代码与静态产物，两个 SQLite 库、运行日志、pi home 都不参与发布，回滚时也不回滚数据。

## 运行拓扑

| 进程 | 监听 | 启动命令 | 数据 |
| --- | --- | --- | --- |
| Caddy 入口 | `0.0.0.0:8095` | `/usr/bin/caddy run --config deploy/Caddyfile` | 无 |
| todo-web-server | `127.0.0.1:8090` | `target/release/todo-web-server` | `~/.ursi/todo/todo.db` |
| ssh-web-server | `127.0.0.1:8091` | `target/release/ssh-web-server` | `~/.ursi/ssh/ssh.db`、`~/.ssh` |
| flow-web | `127.0.0.1:8094` | `node src/main.ts` | `~/.ursi/flow`（只读）、`~/.ursi/flow-web` |
| pi-manager-web | `127.0.0.1:8093` | `node src/server.ts` | `~/.pi/agent`、`$XDG_STATE_HOME/pi-manager-web` |
| pi-sessions-web | `127.0.0.1:30200` | `node src/main.mjs` | 读 `~/.pi/agent/sessions`、`~/.cache/pi-sessions-web` |
| fs-web | `127.0.0.1:8199` | `node apps/fs-web/server/src/server.ts` | `~/.local/state/fs-web/workspaces.json` |
| pi-web | `0.0.0.0:30141` | `next start -H 0.0.0.0 -p 30141` | `~/.pi/agent` |
| dae-web | `0.0.0.0:8092` | `node server/src/server.ts` | 无（dae 在 `127.0.0.1:9527`） |

`5182`、`5183`、`5191`、`5193` 等端口只在开发期使用，不进入本方案。

## 入口路由

| 入口路径 | 目标 | 前缀处理 |
| --- | --- | --- |
| `/` 及其余静态路径 | `apps/shell-web/dist` | SPA 回退 `index.html` |
| `/api/fs-web/*` | `127.0.0.1:8199` | 保留（fs-web 服务自身认这个前缀） |
| `/api/ssh-web/*` | `127.0.0.1:8091` | 把 `/api/ssh-web` 换成 `/api`，含 WebSocket |
| `/api/flow-web/*` | `127.0.0.1:8094` | 换成 `/api` |
| `/api/pi-sessions/*` | `127.0.0.1:30200` | 换成 `/api` |
| `/api/pi-manager/*` | `127.0.0.1:8093` | 去掉前缀（该模块客户端自带 `/api`），关响应缓冲以直通 SSE |
| `/api/*` | `127.0.0.1:8090` | 保留（todo-web 自身就是 `/api`） |

前三家的路径处理不能一律用 `handle_path`：那几个服务端路由是 `/api/...`，工作台传入的前缀只是宿主约定，`vite.config.ts` 里的开发代理同样改写回 `/api`。

Host 头按原值透传。fs-web 用 `Origin` 与 `Host` 比对做跨站防护，Caddy 默认行为满足这个条件。

`deploy/Caddyfile` 的核心内容：

```
:8095 {
	admin off

	handle /api/fs-web/* {
		reverse_proxy 127.0.0.1:8199
	}
	handle /api/ssh-web/* {
		uri replace /api/ssh-web /api
		reverse_proxy 127.0.0.1:8091
	}
	handle /api/flow-web/* {
		uri replace /api/flow-web /api
		reverse_proxy 127.0.0.1:8094
	}
	handle /api/pi-sessions/* {
		uri replace /api/pi-sessions /api
		reverse_proxy 127.0.0.1:30200
	}
	handle_path /api/pi-manager/* {
		reverse_proxy 127.0.0.1:8093 {
			flush_interval -1
		}
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:8090
	}
	handle {
		root * /data/dev/ursi-flow/apps/shell-web/dist
		encode zstd gzip
		try_files {path} /index.html
		file_server
	}
}
```

`admin off` 是必需的：主机上 `127.0.0.1:2019` 已被别的实例占用，用户级 Caddy 不能再抢默认管理端口。压缩只放在静态分支，避免干涉 SSE。

## 构建与发布

依赖：Node 24（用 nvm 绝对路径 `/home/jhihjian/.nvm/versions/node/v24.13.1/bin/node`，单元不依赖 shell 的 PATH）、Rust 工具链、Caddy 2.6.2。`pi-agent-trajectory-viewer` 是 `git+https://…#v0.1.0` 依赖，由根目录 `npm ci` 拉取并执行自身 `prepare`，不需要单独构建。

发布步骤，全部由 `deploy/deploy.sh` 执行，任一步失败即停：

1. 预检：Node 版本、Caddy 可执行、工作区干净（有未提交改动时需显式 `--force`）。
2. `systemctl --user stop` 全部 `ursi-*` 与 `pi-web` 单元。
3. 根目录 `npm ci`（锁文件变化时）与 `npm run build:shell-web`。
4. `cd apps/ursi-flow && npm run build`（flow-web 从包入口取引擎与执行器）。
5. `cargo build --release`（`apps/todo-web`、`apps/ssh-web`）。
6. `apps/pi-web` 内 `npm ci && npm run build`。
7. 安装单元到 `~/.config/systemd/user/`、`daemon-reload`、`enable --now`。
8. 冒烟。

冒烟项：入口 `/` 返回 200；`/api/health`、`/api/ssh-web/health`、`/api/flow-web/flows`、`/api/pi-sessions/health`、`/api/pi-manager/healthz`、`/api/fs-web/workspaces` 返回 200；Pi Web `30141` 返回 200；`ss -ltn` 里除 `8095`、`30141`、`8092` 外没有本仓库进程的对外监听。

回滚：`git checkout <上一版提交>`，锁文件有变化时重跑 `npm ci`，再执行一次 `deploy.sh`。数据目录不动。冒烟任一关键项失败即判回滚。

## 服务管理

八个 systemd 用户单元：`ursi-entry`、`ursi-todo-web`、`ursi-ssh-web`、`ursi-flow-web`、`ursi-pi-manager-web`、`ursi-pi-sessions-web`、`ursi-fs-web`、`pi-web`。dae-web 沿用现有单元。公共约定：

- `Restart=always`、`RestartSec=2`，`WorkingDirectory` 指到各自的服务根（`apps/*/server` 或 Cargo 清单所在目录）；`WorkingDirectory` 不对，`node src/main.ts` 与静态目录解析都会失效。
- 敏感值放 `~/.config/ursi-flow/*.env`（0600），单元里只留 `EnvironmentFile`。目前只有 Pi Web 的 `PI_WEB_PASSWORD` 与 `PI_WEB_ALLOWED_HOSTS`。
- linger 已开启，用户级单元随开机启动，不需要登录会话。

Rust 服务单元示例：

```
[Unit]
Description=ursi-flow todo-web
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/dev/ursi-flow/apps/todo-web
Environment=PORT=8090
Environment=HOST=127.0.0.1
Environment=TODO_WEB_STATIC_DIR=/data/dev/ursi-flow/apps/todo-web/web/dist
ExecStart=/data/dev/ursi-flow/apps/todo-web/target/release/todo-web-server
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

## 备份

两个 SQLite 库用 `sqlite3 ... ".backup"` 取一致性快照；`~/.ursi/flow-web`、`~/.local/state/{fs-web,pi-manager-web}`、`~/.cache/pi-sessions-web` 直接打包。`~/.pi/agent` 含 `auth.json`，按密钥材料处理，与 `~/.config/ursi-flow/pi-web.env` 分开保管。

## 首次落地

1. 让两个 Rust 服务读 `HOST`（默认 `0.0.0.0`，部署传 `127.0.0.1`）。
2. 统一 Pi Web 来源：现在跑的是 `/data/github/pi-web` 的另一份检出，切到仓库 subtree `apps/pi-web`，设置 `PI_WEB_PASSWORD` 与 `PI_WEB_ALLOWED_HOSTS`（用主机名访问 30141 时必须在白名单里，IP 字面量访问不受限）。
3. 停掉手工进程：两个 `target/debug` 二进制、前台 `node` 进程、5191 的 vite。
4. 执行 `deploy.sh`，安装单元并启动。
5. 冒烟后写入 `~/deploy/fact/jhihjian-MACO/fact.md` 与 `~/deploy/history/jhihjian-MACO/`。

仓库根目录的 `deploy/` 是部署配置（Caddyfile、单元、脚本），与记录运行结果的 `~/deploy` 是两回事。

## 范围外与未决

- 沙箱已在 `shell-web` 注册，前缀是 `/sbx`，本方案不给它目标：Gateway 未部署时打开沙箱 profile 会报错。Gateway 就绪后补一条反代即可。
- Pi 管理台的来源边界有一处文档与实现不一致：[apps/pi-manager-web/SPEC.md](../../../apps/pi-manager-web/SPEC.md) 写「写操作仅限本机来源，非回环请求返回 403」，实现里没有任何来源限制，`server.ts` 注释写明「部署在可信局域网内，读写接口均不限制来源」。决定按实现行为描述部署边界：可信局域网内不做应用鉴权，跨出可信网络时由前置代理统一认证。SPEC 那两条验收需要按此修正，落地时一并改。
- 入口与 Pi Web 都是明文 HTTP，`PI_WEB_PASSWORD` 在局域网内明文传输。跨出可信网络时必须走 HTTPS 或 VPN，不在本方案内。
- `~/.ursi/todo/todo.db` 同时被 SUMM-Todo 一侧的进程读写，并发写由 SQLite 自身加锁处理；本方案不引入第二个看板进程。
- 入口静态产物含 4MB 级编辑器分块，静态分支必须保留 `encode`。
