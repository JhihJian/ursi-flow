# workspace-web

工作区文件管理器：类资源管理器功能，按 workspace-shell 模块契约接入。

## 分阶段范围

| 阶段 | 范围 | 明确不做 |
| --- | --- | --- |
| 1（当前） | 本机目录浏览 + 编辑闭环 | SSH、虚拟目录、watch/SSE、拖拽移动、搜索、上传下载、二进制预览 |
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
- SSH 凭据后续只存私钥路径或走 ssh-agent，不落明文。

### 前端：模块接入形态

- 目录树放模块 Panel 栏（内嵌根目录下拉 + 虚拟化列表）；点击文件发布 `workspace.file` 选中，编辑器由外壳工作区区域渲染，不塞进窄栏。
- 树行组件自写 + `@tanstack/react-virtual` 虚拟化。不用 react-arborist（react-dnd 依赖对 React 19 兼容存疑，拖拽本版砍掉）。
- Monaco 经 `@monaco-editor/react` + `monaco-editor` 本地打包（`loader.config` 指向本地 monaco-editor 包 + vite worker 导入），`React.lazy` 分块不进首屏。
- 编辑器草稿与展开状态存 `sessionStorage`（键前缀 `workspace.`，模块卸载保留、刷新丢失）；文件内容不缓存，`apiBaseUrl` 由宿主注入，缺省 `/api/workspace-web`。
- 保存语义：mtime 乐观锁，冲突返回 409，提供「覆盖保存」与「放弃修改」两条路；整体后写覆盖。
- 破坏性操作（删除）用模块内内联确认对话框（契约禁原生 `confirm`）；目录重命名后自动迁移展开状态与草稿 key。

## 代码结构

```
workspace-web/
├── server/            # 服务端（无第三方依赖，Node 24 直跑 TS）
│   ├── src/types.ts         # ApiError / EntryDto / WorkspaceInfo 等共享类型
│   ├── src/local-provider.ts # Provider 接口 + 路径安全 + 本机文件系统实现
│   ├── src/server.ts         # node:http 路由 + workspace 清单 + 启动入口
│   ├── HTTP.md               # HTTP 契约
│   └── test/api.test.ts      # 真实 HTTP 链路测试（node:test）
├── web/src/           # 前端模块（由 apps/workspace 经 @workspace-web 别名引用）
│   ├── api.ts          # HTTP 客户端 + FileKey（JSON segments）工具
│   ├── tree-store.ts   # 树状态：目录缓存、展开序、增删改
│   ├── editor-store.ts # 编辑器状态：草稿、mtime 乐观锁、冲突分支
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
node workspace-web/server/src/server.ts          # 默认 127.0.0.1:8199
WORKSPACE_WEB_CONFIG=xxx.json node workspace-web/server/src/server.ts --host 0.0.0.0 --port 8199

# 前端：嵌入工作区宿主
npm run dev:workspace                            # http://localhost:5191
```

apps/workspace 的 Vite 已把 `/api/workspace-web` 代理到 `127.0.0.1:8199`（`WORKSPACE_WEB_API` 可覆盖）。

## API

见 [server/HTTP.md](server/HTTP.md)。所有请求体与响应为 JSON；路径用 segments 数组传递。

## 测试

```sh
node --test workspace-web/server/test/*.test.ts
```

覆盖路径安全、mtime 冲突、名称校验；只测 server（lib 层为纯函数）。
