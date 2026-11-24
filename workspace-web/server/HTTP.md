# workspace-web HTTP 契约

基址 `/api/workspace-web`。除 `GET workspaces` 外一律 `POST + JSON body`；路径一律用 `path` 字段传 segments 数组（相对 workspace root），不走 URL 编码。错误统一 `{ code, message }`，code 取值见 `server/src/types.ts` 的 `ApiError`。

| 接口 | 方法 | body | 响应 |
| --- | --- | --- | --- |
| workspaces | GET | - | `WorkspaceInfo[]` |
| list | POST | `{ workspaceId, path }` | `{ entries: EntryDto[] }`（目录优先、按名排序） |
| read | POST | `{ workspaceId, path }` | `{ content, mtime, size }`（>2MB 或含 NUL 报错） |
| write | POST | `{ workspaceId, path, content, expectMtime?, overwrite? }` | `{ mtime }`；mtime 不一致返回 409 `conflict`；`overwrite: true` 跳过检查 |
| stat | POST | `{ workspaceId, path }` | `EntryDto` |
| mkdir | POST | `{ workspaceId, path }` | `EntryDto`；已存在返回 409 `exists` |
| rename | POST | `{ workspaceId, path, newName }` | `EntryDto` |
| delete | POST | `{ workspaceId, path }` | `{ ok: true }`；目录递归删除 |

`EntryDto = { name, type: 'dir' \| 'file', size, mtime }`。

## 路径安全

- segments 逐段校验：拒绝 `.`/`..`、绝对段、`/`、`\`、NUL、控制字符、超 255 字符。
- 目标路径 realpath 后必须仍在 root 的 realpath 之下，软链跳出即拒绝（403 `path_outside_root`）。
- 请求体上限 5MB；write 先写同目录临时文件再 rename 原子替换。
