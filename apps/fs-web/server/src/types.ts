/**
 * fs-web 服务端契约：HTTP 层与 provider 层共用。
 * 前端用 `import type` 复制这些类型，不引服务端代码。
 */

export interface WorkspaceConfig {
  /** 小写字母、数字、短横线；用作树缓存与选中的稳定标识。 */
  id: string
  /** 展示名，缺省同 id。 */
  label?: string
  provider: 'local'
  /** 本机绝对路径；先 realpath 再作为前缀。 */
  root: string
}

export interface WorkspaceInfo {
  id: string
  label: string
  provider: 'local'
  /** root 不存在或不可读时为 false，该 workspace 只读出错信息。 */
  ready: boolean
  error?: string
}

/** 单条变更；index/worktree 为 porcelain v1 原始码，未涉及一侧为 ' '。 */
export interface GitChangeDto {
  /** 相对 workspace root 的 segments；rename 取新路径。 */
  path: string[]
  index: string
  worktree: string
  /** untracked 归并目录条目为 'dir'，其余为 'file'。 */
  kind: 'dir' | 'file'
}

export interface GitStatusDto {
  isRepo: boolean
  /** 仓库根（toplevel）；非仓库为 null。 */
  root: string | null
  /** 当前分支；detached HEAD 为 null；无提交仓库给出分支名。 */
  branch: string | null
  upstream?: string
  changes: GitChangeDto[]
  additions: number
  deletions: number
}

export interface EntryDto {
  name: string
  type: 'dir' | 'file'
  /** 字节；目录无意义，填 0。 */
  size: number
  /** 毫秒时间戳。 */
  mtime: number
}

/** 服务端错误：code 供前端分支，message 直接展示。 */
export interface ApiError {
  code:
    | 'workspace_not_found'
    | 'workspace_not_ready'
    | 'bad_request'
    | 'not_found'
    | 'not_dir'
    | 'path_outside_root'
    | 'exists'
    | 'conflict'
    | 'too_large'
    | 'binary'
    | 'git_unavailable'
    | 'io'
  message: string
}
