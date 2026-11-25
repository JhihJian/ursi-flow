# fs-web HTTP 契约

基址 `/api/fs-web`。除 `GET workspaces` 外一律 `POST + JSON body`；路径一律用 `path` 字段传 segments 数组（相对 workspace root），不走 URL 编码。错误统一 `{ code, message }`，code 取值见 `server/src/types.ts` 的 `ApiError`。

## 安全边界

服务无鉴权且可运行时添加任意本机目录（攻击面等于本机文件系统经 HTTP 可读写），因此安全前提是：

- 默认仅绑定 `127.0.0.1`；对外监听必须自行加访问控制。
- 带浏览器 `Origin` 头的请求必须来自回环地址或与 Host 同名的站点（覆盖 shell-web 开发代理形态），否则 403 `forbidden_origin`，防恶意网页盲打写接口；无 Origin 的客户端不受影响。
- 路径安全见下方「路径安全」一节：越出 workspace root 一律拒绝，添加目录只登记不放宽校验。

## workspace 清单与状态文件

清单在服务端持久化：状态文件（默认 `$XDG_STATE_HOME/fs-web/workspaces.json`，回退 `~/.local/state`，`FS_WEB_STATE` 可覆盖）存在即唯一事实源；不存在时用内置默认或 `FS_WEB_CONFIG` 播种并立即写入。运行时 add/rename/remove 即时原子写回（tmp + rename）。文件损坏或条目非法时启动失败（fail-fast），不静默回退。静态配置的 `id` 只允许小写字母、数字与短横线；运行时添加的目录 `id` 取 root realpath 的 sha256 前 16 位 hex。

| 接口 | 方法 | body | 响应 |
| --- | --- | --- | --- |
| workspaces | GET | - | `WorkspaceInfo[]` |
| workspaces-add | POST | `{ root, label? }` | `WorkspaceInfo`；非绝对路径/不存在/非目录报错，已记录返回 409 `exists` |
| workspaces-rename | POST | `{ workspaceId, label?, description? }` | `WorkspaceInfo`；至少一项，只改元数据，id 与 root 不变；传空字符串 description 表示清除说明 |
| workspaces-remove | POST | `{ workspaceId }` | `{ ok: true }`；只从清单移除，不动文件系统，未就绪条目也可移除 |
| list | POST | `{ workspaceId, path }` | `{ entries: EntryDto[] }`（目录优先、按名排序） |
| read | POST | `{ workspaceId, path }` | `{ content, mtime, size }`（>2MB 或含 NUL 报错） |
| write | POST | `{ workspaceId, path, content, expectMtime?, overwrite? }` | `{ mtime }`；mtime 不一致返回 409 `conflict`；`overwrite: true` 跳过检查 |
| stat | POST | `{ workspaceId, path }` | `EntryDto` |
| git-status | POST | `{ workspaceId }` | `{ isRepo, root, branch, upstream?, changes: [{ path, index, worktree, kind }], additions, deletions }`；见下方注释 |
| mkdir | POST | `{ workspaceId, path }` | `EntryDto`；已存在返回 409 `exists` |
| rename | POST | `{ workspaceId, path, newName }` | `EntryDto` |
| delete | POST | `{ workspaceId, path }` | `{ ok: true }`；目录递归删除 |

`EntryDto = { name, type: 'dir' \| 'file', size, mtime }`。

## git-status

只读 Git 状态快照，与用户终端的 git 操作并存：服务端用 `git --no-optional-locks` 只跑只读命令（`status --porcelain=v1 -z --branch`、`rev-parse --show-toplevel`、`diff --numstat HEAD`），永不执行暂存、提交、推送。

- 非 Git 仓库返回 200 `{ isRepo: false, changes: [] }`，不算错误；git 不存在、失败、超时（5s）或输出超限（8MB）统一返回 503 `git_unavailable`，不做部分成功。
- `root` 为仓库根（toplevel）；`branch` 为当前分支，detached HEAD 时为 null；`upstream` 存在时形如 `origin/main`（ahead/behind 本阶段不解析）。
- `changes[].path` 为相对 workspace root 的 segments 数组：git 输出按 toplevel 相对化后，过滤掉 workspace root 之外的条目再转换；仓库内 workspace 之外的变更不返回。
- `index` / `worktree` 为 porcelain v1 原始 X/Y 码；rename 在 `-z` 下是双字段记录，只保留新路径单条（`index: 'R'`）；untracked 目录用 normal 模式归并为单条，`kind: 'dir'` 标记，其余为 `'file'`；冲突状态（DD/AU/UD/UA/DU/AA/UU）直接透传原始码。
- `additions` / `deletions` 为 `git diff --numstat HEAD` 汇总（暂存 + 未暂存相对 HEAD）；空仓库（无 HEAD）置 0；untracked 与二进制文件不计入。
- status 与 numstat 两次调用非原子，响应按「近似快照」理解；更新时机由前端控制：切换目录、手动刷新、mkdir/rename/delete/保存成功后重取。

## 路径安全

- segments 逐段校验：拒绝 `.`/`..`、绝对段、`/`、`\`、NUL、控制字符、超 255 字符。
- 目标路径 realpath 后必须仍在 root 的 realpath 之下，软链跳出即拒绝（403 `path_outside_root`）。
- 请求体上限 5MB；write 先写同目录临时文件再 rename 原子替换。
