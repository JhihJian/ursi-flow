# 单机部署方案

## 目标与边界

把仓库里需要长期在线的 Web 应用部署到一台 Linux 主机上，用 systemd 用户服务常驻并开机自恢复，浏览器只认一个工作台入口，另留 dae 观察台一个独立入口。

方案不绑定具体主机、用户名与安装路径：安装根就是仓库检出目录，入口地址、后端端口、监听地址由 `deploy/deploy.env` 覆盖，systemd 单元与 Caddy 配置在安装时按当前环境渲染。换一台机器只要满足前提，执行同一个脚本即可。

不做容器化、多机编排、镜像发布与产物打包。开发前提是可信局域网、应用层不做鉴权，本方案不改变这个边界，只把暴露面收进入口。沙箱平台（需要 Docker 与 Gateway）、chat-web（需要 AI Gateway 密钥）、mcp-web（自带打包发布路线）不在范围内。

## 前提

| 项 | 要求 |
| --- | --- |
| 系统 | Linux，systemd 用户实例可用（`systemctl --user` 能执行），`loginctl` 可查 |
| Node | 24（各包 `engines` 限定 `>=24 <25`），构建与运行共用同一个二进制 |
| Caddy | 2.x，需要 `handle`、`handle_path`、`uri replace`、`encode` 指令 |
| 构建环境 | Rust 稳定版工具链、可访问 npm 与 GitHub `git` 依赖 |
| 运行环境 | OpenSSH 客户端、curl（冒烟用）、可写的用户 home、可选 dae（只影响 dae-web） |
| 后台常驻 | 建议开启 linger，否则用户注销后单元会停止 |

## 参数

`deploy/deploy.env.example` 是模板，复制成 `deploy/deploy.env` 后按需修改，该文件不入库。脚本按 `参数 > 环境变量 > 默认值` 的顺序取值。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `ENTRY_ADDR` | `:8095` | Caddy 入口监听地址，端口冲突时改这里 |
| `BACKEND_HOST` | `127.0.0.1` | 六个后端的监听地址 |
| `TODO_PORT` | `8090` | todo-web |
| `SSH_PORT` | `8091` | ssh-web |
| `FLOW_PORT` | `8094` | flow-web |
| `PI_MANAGER_PORT` | `8093` | pi-manager-web |
| `PI_SESSIONS_PORT` | `30200` | pi-sessions-web |
| `FS_PORT` | `8199` | fs-web |
| `NODE` | PATH 里的 `node` | 单元里写入该绝对路径 |
| `CADDY` | PATH 里的 `caddy` | 入口单元与配置校验使用 |

安装根取脚本所在仓库的绝对路径，不需要配置。渲染产物写在用户目录下：Caddy 配置在 `$XDG_STATE_HOME/ursi-flow/Caddyfile`，单元在 `$XDG_CONFIG_HOME/systemd/user/`。仓库目录或 Node 路径变了，重跑脚本即可重新渲染，单元不保存旧路径。

## 关键决定

### 统一入口用 Caddy

工作区各模块都以同源前缀 `/api/...` 访问后端，前缀表本来就写在 `apps/shell-web/vite.config.ts` 的开发代理里。生产侧需要的静态托管、SPA 回退、WebSocket 升级与 SSE 直通，Caddy 一页配置即可覆盖；再写一个 Node 网关等于把代理、升级、回退重复实现一遍。

代价是路由表存在两份：开发期在 `vite.config.ts`，生产在 `deploy/Caddyfile.tmpl`。新增模块前缀时两处都要改，这一条写进模块接入检查项。

### 后端收敛到回环，另留 dae 观察台一个入口

- 六个后端只服务入口，绑 `BACKEND_HOST`。Node 服务都已有 `*_HOST` 变量；两个 Rust 服务把 `0.0.0.0` 写死，需要补 `HOST` 变量（默认值保持 `0.0.0.0`，独立启动行为不变），部署时传回环地址。
- dae-web 单独监听：它的配置写操作只认 `req.socket.remoteAddress` 是真实回环对端（`apps/dae-web/server/src/server.ts:38`），经反代后所有来源都变成回环地址，这道限制会失效。它本来也不在工作区里，独立成门没有损失。
- 收敛的前提是后端不自己做鉴权，因此入口不能再往下转发一层就当作安全边界。需要跨出可信网络时，由前置代理统一做 TLS 与认证。

### 构建产物留在树内，版本就是 git commit

不建发布目录、不打包产物：脚本在仓库里原地构建，单元指向树内路径，回滚是 `git checkout` 到上一个提交再构建一次。发布期间先停单元再构建，避免旧进程读到半成品静态产物。单机自用场景下，接受每次发布一到两分钟的中断。

只构建被服务的产物。`shell-web` 的模块导出指向各包的 `src/module.tsx`（见各 `web/package.json` 的 `exports`），构建时直接从源码编译，因此不需要预先构建各模块自己的 `web/dist`；那些页面只在单独打开对应后端端口时才有用，不进入发布流程。

### 数据目录不随发布变动

数据都在运行用户的 home 下（见拓扑表）。发布只替换代码与静态产物，SQLite 库、运行日志、pi home 都不参与发布，回滚时也不回滚数据。

## 运行拓扑

| 进程 | 监听 | 启动命令 | 数据 |
| --- | --- | --- | --- |
| Caddy 入口 | `ENTRY_ADDR` | `caddy run --config <状态目录>/Caddyfile` | 无 |
| todo-web-server | `BACKEND_HOST:TODO_PORT` | `target/release/todo-web-server` | `~/.ursi/todo/todo.db` |
| ssh-web-server | `BACKEND_HOST:SSH_PORT` | `target/release/ssh-web-server` | `~/.ursi/ssh/ssh.db`、`~/.ssh` |
| flow-web | `BACKEND_HOST:FLOW_PORT` | `node src/main.ts` | `~/.ursi/flow`（只读）、`~/.ursi/flow-web` |
| pi-manager-web | `BACKEND_HOST:PI_MANAGER_PORT` | `node src/server.ts` | `~/.pi/agent`、`$XDG_STATE_HOME/pi-manager-web` |
| pi-sessions-web | `BACKEND_HOST:PI_SESSIONS_PORT` | `node src/main.mjs` | 读 `~/.pi/agent/sessions`、`~/.cache/pi-sessions-web` |
| fs-web | `BACKEND_HOST:FS_PORT` | `node apps/fs-web/server/src/server.ts` | `~/.local/state/fs-web/workspaces.json` |
| dae-web | 独立端口，默认 `8092` | `node server/src/server.ts` | 无（dae 默认在 `127.0.0.1:9527`） |

`URSI_DATA_DIR`、`TODO_DB_PATH`、`SSH_DB_PATH`、`PI_CODING_AGENT_DIR` 等变量由各模块自己读取，部署脚本不改写，需要迁移数据目录时按各模块 README 设置。

## 入口路由

| 入口路径 | 目标 | 前缀处理 |
| --- | --- | --- |
| `/` 及其余静态路径 | `apps/shell-web/dist` | SPA 回退 `index.html` |
| `/api/fs-web/*` | fs-web | 保留（fs-web 服务自身认这个前缀） |
| `/api/ssh-web/*` | ssh-web | 把 `/api/ssh-web` 换成 `/api`，含 WebSocket |
| `/api/flow-web/*` | flow-web | 换成 `/api` |
| `/api/pi-sessions/*` | pi-sessions-web | 换成 `/api` |
| `/api/pi-manager/*` | pi-manager-web | 去掉前缀（该模块客户端自带 `/api`），关响应缓冲以直通 SSE |
| `/api/*` | todo-web | 保留（todo-web 自身就是 `/api`） |

前三家的路径处理不能一律用 `handle_path`：那几个服务端路由是 `/api/...`，工作台传入的前缀只是宿主约定，`vite.config.ts` 里的开发代理同样改写回 `/api`。

Host 头按原值透传。fs-web 用 `Origin` 与 `Host` 比对做跨站防护，Caddy 默认行为满足这个条件。

`deploy/Caddyfile.tmpl` 是模板，占位符由脚本渲染。模板结构：

```
{
	admin off
}

@ENTRY_ADDR@ {
	handle /api/fs-web/* {
		reverse_proxy @BACKEND_HOST@:@FS_PORT@
	}
	handle /api/ssh-web/* {
		uri replace /api/ssh-web /api
		reverse_proxy @BACKEND_HOST@:@SSH_PORT@
	}
	handle /api/flow-web/* {
		uri replace /api/flow-web /api
		reverse_proxy @BACKEND_HOST@:@FLOW_PORT@
	}
	handle /api/pi-sessions/* {
		uri replace /api/pi-sessions /api
		reverse_proxy @BACKEND_HOST@:@PI_SESSIONS_PORT@
	}
	handle_path /api/pi-manager/* {
		reverse_proxy @BACKEND_HOST@:@PI_MANAGER_PORT@ {
			flush_interval -1
		}
	}
	handle /api/* {
		reverse_proxy @BACKEND_HOST@:@TODO_PORT@
	}

	# 静态产物走单独的 handle，压缩只作用于这里，不干涉 SSE。
	handle {
		root * @ROOT@/apps/shell-web/dist
		encode zstd gzip
		try_files {path} /index.html
		file_server
	}
}
```

渲染后脚本执行一次 `caddy validate`，配置不合法就停在启动之前。`admin off` 的理由是本方案不需要运行时改配置，同时避开同机其它 Caddy 实例默认占用的管理端口。

## 构建与发布

`pi-agent-trajectory-viewer` 是 `git+https://…#v0.1.0` 依赖，由根目录 `npm ci` 拉取并执行自身 `prepare`，不需要单独构建。

发布步骤全部由 `deploy/deploy.sh` 执行，任一步失败即停：

1. 预检：Node 大版本、Caddy 可执行、systemd 用户实例可用、工作区干净（有未提交改动时需显式 `--force`），linger 未开启时给出警告。
2. `systemctl --user stop` 全部 `ursi-*` 单元。
3. 根目录 `npm ci`（锁文件变化时）与 `npm run build:shell-web`。
4. `cd apps/ursi-flow && npm run build`（flow-web 从包入口取引擎与执行器）。
5. `cargo build --release`（`apps/todo-web`、`apps/ssh-web`）。
6. 渲染 Caddy 配置与七个单元，`caddy validate` 通过后 `daemon-reload`、`enable --now`。
7. 冒烟。

冒烟项：入口 `/` 返回 200；`/api/health`、`/api/ssh-web/health`、`/api/flow-web/flows`、`/api/pi-sessions/health`、`/api/pi-manager/healthz`、`/api/fs-web/workspaces` 返回 200；`ss -ltn` 里六个后端只监听 `BACKEND_HOST`。

回滚：`git checkout <上一版提交>`，锁文件有变化时重跑 `npm ci`，再执行一次 `deploy.sh`。数据目录不动。冒烟任一关键项失败即判回滚。

## 服务管理

七个 systemd 用户单元：`ursi-entry`、`ursi-todo-web`、`ursi-ssh-web`、`ursi-flow-web`、`ursi-pi-manager-web`、`ursi-pi-sessions-web`、`ursi-fs-web`。dae-web 用自己的单元，不在脚本管理范围内。公共约定：

- 单元模板里用 `@ROOT@`、`@NODE@`、`@CADDY@`、端口与监听地址占位符，安装时渲染，仓库移动后重跑脚本即可。
- `Restart=always`、`RestartSec=2`，`WorkingDirectory` 指到各自的服务根（`apps/*/server` 或 Cargo 清单所在目录）；`WorkingDirectory` 不对，`node src/main.ts` 与静态目录解析都会失效。
- 单元里不写密钥。将来出现需要密钥的服务，把值放 `~/.config/ursi-flow/*.env`（0600）用 `EnvironmentFile` 引入。

Rust 服务单元示例：

```
[Unit]
Description=ursi-flow todo-web
After=network.target

[Service]
Type=simple
WorkingDirectory=@ROOT@/apps/todo-web
Environment=PORT=@TODO_PORT@
Environment=HOST=@BACKEND_HOST@
Environment=TODO_WEB_STATIC_DIR=@ROOT@/apps/todo-web/web/dist
ExecStart=@ROOT@/apps/todo-web/target/release/todo-web-server
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

## 备份

两个 SQLite 库用 `sqlite3 ... ".backup"` 取一致性快照；`~/.ursi/flow-web`、`~/.local/state/{fs-web,pi-manager-web}`、`~/.cache/pi-sessions-web` 直接打包。`~/.pi/agent` 含 `auth.json`，按密钥材料处理，单独保管。

## 首次部署

1. 按「前提」装好 systemd、Node 24、Caddy、Rust 工具链，必要时开启 linger。
2. 需要改端口时复制 `deploy/deploy.env.example` 为 `deploy/deploy.env` 并修改；默认端口被占用就先改这里。
3. 给两个 Rust 服务补 `HOST` 变量（见「范围外与未决」），否则单元里的监听地址不生效。
4. 执行 `deploy/deploy.sh`，脚本完成构建、渲染、安装与启动。
5. 冒烟通过后把本次部署写入使用者自己的部署记录目录。

## 范围外与未决

- 两个 Rust 服务（`apps/todo-web/server`、`apps/ssh-web/server`）目前把 `0.0.0.0` 写死在 `main.rs`，方案依赖补 `HOST` 变量才能绑回环。默认值保持 `0.0.0.0`，独立启动方式不变。
- 沙箱已在 `shell-web` 注册，前缀是 `/sbx`，本方案不给它目标：Gateway 未部署时打开沙箱 profile 会报错。Gateway 就绪后补一条反代即可。
- Pi 管理台的来源边界有一处文档与实现不一致：[apps/pi-manager-web/SPEC.md](../../../apps/pi-manager-web/SPEC.md) 写「写操作仅限本机来源，非回环请求返回 403」，实现里没有任何来源限制，`server.ts` 注释写明「部署在可信局域网内，读写接口均不限制来源」。决定按实现行为描述部署边界：可信局域网内不做应用鉴权，跨出可信网络时由前置代理统一认证。SPEC 那两条验收需要按此修正。
- 入口是明文 HTTP，浏览器到入口的流量不加密。跨出可信网络时必须走 HTTPS 或 VPN，不在本方案内。
- `~/.ursi/todo/todo.db` 可能同时被 SUMM-Todo 一侧的进程读写，并发写由 SQLite 自身加锁处理；本方案不引入第二个看板进程。
- 入口静态产物含 4MB 级编辑器分块，静态分支必须保留 `encode`。
