# fs-web

工作区文件管理器：类资源管理器功能，按 workspace-shell 模块契约接入。

## 分阶段范围

| 阶段 | 范围 | 明确不做 |
| --- | --- | --- |
| 1（当前） | 本机目录浏览 + 编辑闭环 + 运行时目录管理（状态文件持久化、二级侧栏目录列表） | SSH、虚拟目录、watch/SSE、拖拽移动、搜索、上传下载、二进制预览 |
| 1.5 | 只读 Git 状态视图：分支/上游、变更文件徽标与目录聚合、增删行数（手动刷新 + 文件操作后刷新） | diff 内容查看、暂存/提交/推送、轮询与自动刷新、SSH 远端 git |
| 2 | SSH provider：连接池 + keepalive、操作超时、错误分类 | 远程 watch、跨主机复制 |
| 3 | 虚拟目录聚合 + 本地 SSE 推送 | 跨挂载点移动 |

## 关键决策

### 后端：Node 原生 http + Node 类型剥离（.ts 直跑）

Node 24 原生运行 TypeScript（`--experimental-strip-types` 已默认，仅做类型剥离）。服务不引入 Web 框架，用 `node:http` 直写路由，与 pi-executor/session-service 形态一致，无依赖。

### 统一目录抽象：能力声明式 Provider

```
WorkspaceProvider = { list, read, write, stat, mkdir, rename, delete }
watch 是可选能力，local 后续实现，SSH 不实现（SFTP 无变更通知）
```

传输层不用 URI 字符串，用 `workspaceId + path segments 数组`，规避文件名 `#`/空格/中文的编解码问题。虚拟目录后续实现为挂载点表聚合：最长前缀优先遮蔽、挂载点自身不可 rename/delete、跨挂载点移动拒绝。

### 安全基线

- workspace `root` 先 `realpath` 再作为前缀；每个请求路径逐段校验（拒绝 `..`、绝对段、NUL），最终路径必须以 root 前缀开头。
- root 内符号链接指向外部时拒绝访问（read/write/stat/delete 都校验 realpath 前缀）。
- 服务默认绑定 `127.0.0.1`，无鉴权；对外暴露需自行加访问控制。
- 带浏览器 `Origin` 头的写请求必须来自回环地址或与 Host 同名的站点，否则拒绝（403 `forbidden_origin`），防恶意网页盲打；无 Origin 的客户端（curl 等）不受影响。
- 运行时可添加任意本机目录，攻击面等于「本机文件系统经 HTTP 可读写」，以仅回环监听 + Origin 校验为前提；SSH 凭据后续只存私钥路径或走 ssh-agent，不落明文。

### 运行时目录管理：状态文件是唯一事实源

- 清单不再只靠启动配置：首启用内置默认或 `FS_WEB_CONFIG` 播种，写入运行时状态文件（默认 `~/.local/state/fs-web/workspaces.json`，`FS_WEB_STATE` 可覆盖）；此后 `FS_WEB_CONFIG` 不再生效。
- 运行时添加/重命名/移除走 API，变更原子写回状态文件（tmp + rename），重启保留；文件损坏启动即报错，不静默回退。
- 添加的目录 `id` 取 root realpath 的 sha256 前 16 位，跨重启稳定，重命名不影响已打开文件。

### 前端：二级侧边栏

- 模块栏为二级侧边栏（参考 todo-web ProjectSidebar）：一级 144px 固定宽目录列表，点击切换、右键重命名/移除（内联输入与内联确认，契约禁原生对话框）；二级为 git 摘要 + 虚拟化文件树。
- 点击文件发布 `workspace.file` 选中，编辑器由外壳工作区区域渲染，不塞进窄栏；树行组件自写 + `@tanstack/react-virtual` 虚拟化。
- Monaco 经 `@monaco-editor/react` + `monaco-editor` 本地打包（`loader.config` 指向本地 monaco-editor 包 + vite worker 导入），`React.lazy` 分块不进首屏。
- 编辑器草稿与展开状态存内存（页面刷新即丢，后续可评估 sessionStorage）；文件内容不缓存，`apiBaseUrl` 由宿主注入，缺省 `/api/fs-web`。
- 保存语义：mtime 乐观锁，冲突返回 409，提供「覆盖保存」与「放弃修改」两条路；整体后写覆盖。
- 破坏性操作（删除、移除目录）用内联确认；目录重命名后自动迁移展开状态与草稿 key。

### Git 状态：只读快照

资源管理器的主要浏览对象是 Git 仓库，最高频的问题是「仓库现在什么状态、刚改了哪些文件」。Git 视图定位只读：分支、变更文件、增删行数、树内徽标；暂存、提交、推送属 CLI / agent 工作流，永不进入本模块。行级 diff 查看是再下一阶段，契约形态参考 `pi-executor/lib/git-types.ts` 的 `GitFileDiffResponse`（per-file 只读 patch）。

服务端 `git-provider.ts` 用 `execFile` 只跑三条只读命令，零依赖：

```
git --no-optional-locks status --porcelain=v1 -z --branch
git rev-parse --show-toplevel
git diff --numstat HEAD
```

- `--no-optional-locks` 保证与用户终端的 `git add/commit` 并存，不抢 index.lock。
- porcelain v1 `-z` 解析要点：rename 是双字段记录（新路径在前），只保留新路径单条；branch 行三种形态——`## main...origin/main [ahead 1]`（ahead/behind 本阶段不解析）、`## HEAD (no branch)`（detached，branch 为 null）、`## No commits yet on main`（空仓库）。解析器为纯函数，单测以 `git init` 临时仓库的 `-z` 实测输出固化（见 api.test.ts）。
- untracked 用默认 normal 模式，未跟踪目录归并为单条（防 node_modules 爆炸），目录条目以 `kind: 'dir'` 标记。
- numstat 口径为 `diff HEAD`（暂存 + 未暂存相对 HEAD 汇总）；空仓库（无 HEAD）时置 0；untracked 与二进制文件不计行数。
- 超时 5s、输出上限 8MB；git 不存在、失败、超时或超限统一返回 503 `git_unavailable`，不做部分成功。
- `gitStatus` 是 provider 第一个代码化的可选能力：`WorkspaceProvider` 接口声明 `gitStatus?`，路由按 `typeof provider.gitStatus === 'function'` 分支；local 实现，SSH 不实现（路由返回 501）。

路径映射：git 输出相对仓库根（toplevel），服务端用 `rev-parse --show-toplevel` 相对化后，过滤出 workspace root 之内的条目，转成相对 workspace root 的 segments 数组返回；仓库内 workspace 之外的变更不返回。

快照语义与刷新：status 与 numstat 两次调用非原子，按「近似快照」理解；刷新触发点为切换 workspace、点击刷新、mkdir/rename/delete/保存成功后；前端用请求序号丢弃过期响应；不做轮询与 watch 联动（SSE 阶段再考虑）。

前端 `git-store.ts`（快照 + 徽标映射 + 过期丢弃）：树行按变更状态显示字母徽标（M/A/D/R/C/U），目录聚合计数由前端按 path 前缀计算；树顶部摘要条显示分支、上游与变更数，兼作手动刷新入口；非仓库 workspace 不渲染任何 git 区块。


## 代码结构

```
fs-web/
├── server/            # 服务端（无第三方依赖，Node 24 直跑 TS）
│   ├── src/types.ts         # ApiError / EntryDto / WorkspaceInfo 等共享类型
│   ├── src/local-provider.ts # Provider 接口 + 路径安全 + 本机文件系统实现
│   ├── src/git-provider.ts   # git 只读命令封装与 porcelain 解析
│   ├── src/server.ts         # node:http 路由 + workspace 清单 + 状态文件 + 启动入口
│   ├── HTTP.md               # HTTP 契约
│   └── test/api.test.ts      # 真实 HTTP 链路测试（node:test）
├── web/src/           # 前端模块（导出 @ursi/fs-web 的 ./module 接入入口，也提供独立预览）
│   ├── api.ts          # HTTP 客户端 + FileKey（JSON segments）工具
│   ├── tree-store.ts   # 树状态：清单、目录缓存、展开序、增删改、运行时目录管理
│   ├── git-store.ts    # git 快照：徽标映射、过期丢弃
│   ├── git-bar.tsx     # git 摘要条（分支/变更数/重试入口）
│   ├── editor-store.ts # 编辑器状态：草稿、mtime 乐观锁、冲突分支
│   ├── workspace-list.tsx # 一级目录列表（添加/重命名/移除，右键菜单）
│   ├── explorer.tsx    # 二级侧边栏布局（目录列表 + git 摘要 + 文件树）
│   ├── tree.tsx        # 虚拟化文件树（行内重命名、悬浮删除）
│   ├── dir-actions.tsx # 选中目录工具条（刷新/新建/重命名/删除）
│   ├── file-editor.tsx # Monaco 封装（本地打包 + worker，React.lazy 懒加载）
│   ├── file-view.tsx   # 外壳工作区区域的文件视图
│   ├── module.tsx      # createWorkspaceModule 模块工厂
│   └── module.css      # 模块样式（全部 wsx- 前缀，限定容器内）
└── SPEC.md
```

## 开发

```sh
# 服务（无依赖，Node 24 直跑 TS）
node fs-web/server/src/server.ts          # 默认 127.0.0.1:8199；目录清单存 ~/.local/state/fs-web/
FS_WEB_CONFIG=xxx.json node fs-web/server/src/server.ts --host 0.0.0.0 --port 8199   # 仅首次播种；FS_WEB_STATE 可改状态文件位置

# 前端：嵌入工作区宿主
npm run dev:shell-web                           # http://localhost:5191
```

shell-web 的 Vite 已把 `/api/fs-web` 代理到 `127.0.0.1:8199`（`FS_WEB_API` 可覆盖）。

## API

见 [server/HTTP.md](server/HTTP.md)。所有请求体与响应为 JSON；路径用 segments 数组传递。

## 测试

```sh
node --test fs-web/server/test/*.test.ts
```

覆盖路径安全、mtime 冲突、名称校验；只测 server（lib 层为纯函数）。git 用例以 `git init` 临时仓库覆盖 rename 双记录、非仓库降级、空仓库、仓库子目录过滤与 upstream 形态。
