import { useCallback, useMemo, useState } from 'react'
import { useTreeStore } from './tree-store.ts'
import { useGitStore } from './git-store.ts'
import {
  GitPopover,
  flattenBranchNodes,
  flattenChangeRows,
  type GitPopoverState,
  type PopoverTreeRow,
} from './git-popover.tsx'
import { badgeCodeOf } from './git-store.ts'
import type { GitBranchNodeDto, GitBranchesDto } from '../../server/src/types.ts'

/** 弹层数据源：分支树或变更文件树；rows 渲染时按 expanded 实时展开。 */
interface PopoverData {
  kind: 'branches' | 'changes'
  heading: string
  branches?: GitBranchesDto
  changes?: Array<{ path: string; badge: string }>
}

/** branches 数据 → 本地/远端拼好的行列表。 */
function branchRowsOf(
  dto: GitBranchesDto,
  expanded: Set<string>,
  toggleExpand: (key: string) => void,
): PopoverTreeRow[] {
  const withToggle = (rows: PopoverTreeRow[]): PopoverTreeRow[] =>
    rows.map((row) => (row.kind === 'dir' ? { ...row, onClick: () => toggleExpand(row.key) } : row))
  return [
    // 本地分支段
    ...withToggle(flattenBranchNodes(dto.locals, expanded)),
    // 远端分支段：顶层加「origin/」前缀的目录行作为分组标题已在树里，无需额外标题
    ...withToggle(flattenBranchNodes(dto.remotes, expanded)),
  ]
}

/** 变更条目 → 目录树行，文件行点击打开。 */
function changeRowsOf(
  workspaceId: string,
  changes: Array<{ path: string; badge: string }>,
  expanded: Set<string>,
  toggleExpand: (key: string) => void,
  onOpenFile?: (key: string) => void,
): PopoverTreeRow[] {
  return flattenChangeRows(changes, expanded).map((row) => {
    if (row.kind === 'change-dir') return { ...row, onClick: () => toggleExpand(row.key) }
    return {
      ...row,
      onClick:
        onOpenFile &&
        (() =>
          onOpenFile(
            JSON.stringify([workspaceId, ...row.key.split('/')]),
          )),
    }
  })
}

/** 侧栏 git 摘要：分支 chip + 变更徽标 + 推送/拉取按钮。
 *  分支 chip 点击弹出本地/远端分支树；变更 chip 点击弹出当前目录的变更文件树（点文件打开）。
 *  ↑N 表示待推送（领先 upstream 的提交数），点击推送；↓M 表示待拉取，点击拉取。
 *  无 upstream 或数量为 0 时按钮禁用；同步失败在状态条显示错误，点击可关闭。 */
export function GitBar({ onOpenFile }: { onOpenFile?: (key: string) => void }) {
  const api = useTreeStore((state) => state.api)
  const workspaceId = useTreeStore((state) => state.activeWorkspaceId)
  const snapshot = useGitStore((state) => state.snapshot)
  const loading = useGitStore((state) => state.loading)
  const error = useGitStore((state) => state.error)
  const syncPhase = useGitStore((state) => state.sync.phase)
  const clearError = useGitStore((state) => state.clearError)
  const [data, setData] = useState<PopoverData | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)

  const toggleExpand = useCallback((key: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const closePopover = useCallback((): void => {
    setData(null)
    setAnchorEl(null)
  }, [])

  // rows 每次渲染按 expanded 实时展开；目录行 open 状态同步
  const popover: GitPopoverState | null = useMemo(() => {
    if (!data || !anchorEl) return null
    const rows =
      data.kind === 'branches' && data.branches
        ? branchRowsOf(data.branches, expanded, toggleExpand)
        : data.kind === 'changes' && data.changes
          ? changeRowsOf(workspaceId ?? '', data.changes, expanded, toggleExpand, onOpenFile)
          : []
    return { anchor: anchorEl, heading: data.heading, rows }
  }, [data, anchorEl, expanded, toggleExpand, workspaceId, onOpenFile])

  if (!workspaceId || (!snapshot && !error)) return null

  const retry = (): void => {
    clearError()
    void useGitStore.getState().refresh(api, workspaceId)
  }

  if (error) {
    return (
      <div className="wsx-git-bar">
        <button type="button" className="wsx-git-chip wsx-git-chip--error" onClick={retry}>
          git 状态获取失败，点击重试
        </button>
      </div>
    )
  }

  if (!snapshot) return null
  const branchLabel = snapshot.branch ?? 'detached'
  const changes = snapshot.changes.filter((change) => change.kind === 'file')
  const additions = snapshot.additions
  const deletions = snapshot.deletions
  // detached / 无 upstream 时不可同步；同步进行中禁用两个按钮
  const syncable = Boolean(snapshot.branch && snapshot.upstream) && !syncPhase
  const canPush = syncable && snapshot.ahead > 0
  const canPull = syncable && snapshot.behind > 0
  const upstreamTitle = snapshot.upstream ? `${branchLabel} → ${snapshot.upstream}` : branchLabel

  /** 收集分支树里所有目录路径（默认全展开用）。 */
  const collectDirPaths = (nodes: GitBranchNodeDto[], prefix = ''): string[] => {
    const paths: string[] = []
    for (const node of nodes) {
      if (node.kind === 'dir') {
        const path = prefix === '' ? node.name : `${prefix}/${node.name}`
        paths.push(path)
        paths.push(...collectDirPaths(node.children ?? [], path))
      }
    }
    return paths
  }

  /** 打开分支弹层：拉分支树，目录默认全展开；再点 chip 收起。 */
  const openBranches = (anchor: HTMLElement): void => {
    if (data?.kind === 'branches') {
      closePopover()
      return
    }
    setData({ kind: 'branches', heading: '分支加载中…' })
    setAnchorEl(anchor)
    void api
      .gitBranches(workspaceId)
      .then((dto) => {
        const initial = new Set([...collectDirPaths(dto.locals), ...collectDirPaths(dto.remotes)])
        setExpanded(initial)
        setData({
          kind: 'branches',
          heading: dto.isRepo ? (dto.branch ? `分支（当前：${dto.branch}）` : '分支（detached）') : '非 git 仓库',
          branches: dto,
        })
      })
      .catch(() => {
        setData({ kind: 'branches', heading: '分支获取失败' })
      })
  }

  /** 打开变更弹层：当前 workspace 的变更文件建目录树，目录默认全展开；再点 chip 收起。 */
  const openChanges = (anchor: HTMLElement): void => {
    if (data?.kind === 'changes') {
      closePopover()
      return
    }
    const entries = changes.map((change) => ({
      path: change.path.join('/'),
      badge: badgeCodeOf(change),
    }))
    const initial = new Set<string>()
    for (const entry of entries) {
      const parts = entry.path.split('/')
      for (let i = 1; i < parts.length; i++) initial.add(parts.slice(0, i).join('/'))
    }
    setExpanded(initial)
    setAnchorEl(anchor)
    setData({
      kind: 'changes',
      heading: `变更（${changes.length} 文件 +${additions}/-${deletions}）`,
      changes: entries,
    })
  }

  return (
    <>
      <div className="wsx-git-bar">
        <button
          type="button"
          className={
            'wsx-git-chip wsx-git-chip--branch' +
            (data?.kind === 'branches' ? ' wsx-git-chip--open' : '')
          }
          onClick={(event) => openBranches(event.currentTarget)}
          title={`${upstreamTitle}，点击查看分支列表`}
        >
          <span className="wsx-git-branch">{loading ? '…' : branchLabel}</span>
        </button>
        <button
          type="button"
          className={
            'wsx-git-chip' + (data?.kind === 'changes' ? ' wsx-git-chip--open' : '')
          }
          onClick={(event) => openChanges(event.currentTarget)}
          title={`${changes.length} 个文件有改动，共新增 ${additions} 行、删除 ${deletions} 行（相对上次提交），点击查看变更文件`}
        >
          {changes.length} +{additions}/-{deletions}
        </button>
        <span className="wsx-git-sync">
          <button
            type="button"
            className="wsx-git-chip wsx-git-sync-btn"
            disabled={!canPush}
            onClick={() => void useGitStore.getState().syncUpstream(api, workspaceId, 'push')}
            title={
              snapshot.upstream
                ? `推送 ${snapshot.ahead} 个提交到 ${snapshot.upstream}`
                : '当前分支没有上游，无法推送'
            }
          >
            ↑{snapshot.ahead}
          </button>
          <button
            type="button"
            className="wsx-git-chip wsx-git-sync-btn"
            disabled={!canPull}
            onClick={() => void useGitStore.getState().syncUpstream(api, workspaceId, 'pull')}
            title={
              snapshot.upstream
                ? `从 ${snapshot.upstream} 拉取 ${snapshot.behind} 个提交`
                : '当前分支没有上游，无法拉取'
            }
          >
            ↓{snapshot.behind}
          </button>
        </span>
      </div>
      <GitPopover state={popover} onClose={closePopover} />
    </>
  )
}
