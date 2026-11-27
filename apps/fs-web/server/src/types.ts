/**
 * fs-web 服务端契约：HTTP 层与 provider 层共用。
 * 前端用 `import type` 复制这些类型，不引服务端代码。
 */

import type { Location } from '@ursi/location'

export interface WorkspaceConfig {
  /** 清单内唯一；静态配置用 slug，运行时添加用 root 位置键（见 `@ursi/location/keys`）。 */
  id: string
  /** 展示名，缺省同 id。 */
  label?: string
  /** 一句话说明（这是什么目录），可选。 */
  description?: string
  /** 与 root 的 scheme 一一对应：file 走本机 provider，ssh 走远程 provider。 */
  provider: Location['scheme']
  /** 工作目录的身份：位置 URI（`file:///abs` 或 `ssh://<设备>/abs`）。 */
  root: string
}

export interface WorkspaceInfo {
  id: string
  label: string
  /** 一句话说明；无说明时不返回。 */
  description?: string
  provider: Location['scheme']
  /** 位置 URI（运行时添加的条目为 realpath 后的规范 URI）。 */
  root: string
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
  /** 领先上游的提交数；无 upstream 或无跟踪关系时为 0。 */
  ahead: number
  /** 落后上游的提交数；无 upstream 或无跟踪关系时为 0。 */
  behind: number
  changes: GitChangeDto[]
  additions: number
  deletions: number
}

/** 分支树节点：目录节点聚合同名前缀（feature/xxx），叶子是分支。 */
export interface GitBranchNodeDto {
  name: string
  /** 目录节点为 'dir'，分支叶子为 'branch'。 */
  kind: 'dir' | 'branch'
  /** 仅分支叶子：短 hash。 */
  hash?: string
  /** 仅本地分支叶子：是否当前分支。 */
  current?: boolean
  /** 仅分支叶子：跟踪的上游。 */
  upstream?: string
  children?: GitBranchNodeDto[]
}

export interface GitBranchesDto {
  isRepo: boolean
  /** 当前分支（detached 为 null）。 */
  branch: string | null
  /** 本地分支树；非仓库为空数组。 */
  locals: GitBranchNodeDto[]
  /** 远端分支树（按远端名分组，origin 是顶层目录）。 */
  remotes: GitBranchNodeDto[]
}

export interface EntryDto {
  name: string
  type: 'dir' | 'file'
  /** 字节；目录无意义，填 0。 */
  size: number
  /** 毫秒时间戳。 */
  mtime: number
}

/** 任意目录浏览：给选目录组件用，只列子目录，不碰文件。 */
export interface DirListingDto {
  /** 规范位置 URI（本机为 realpath 后的 `file://`，远程为 `ssh://<设备>` + 真实路径），组件以它为锚。 */
  location: string
  /** 上一级目录；设备根目录为 null。 */
  parent: string | null
  /** 子目录名，按名称排序。 */
  entries: { name: string }[]
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
    | 'forbidden_origin'
    | 'exists'
    | 'conflict'
    | 'too_large'
    | 'binary'
    | 'git_unavailable'
    | 'ssh_unavailable'
    | 'device_not_found'
    | 'io'
  message: string
}
