import { useTreeStore } from './tree-store.ts'
import { useGitStore } from './git-store.ts'

/** 窄栏顶部的 git 摘要条：分支 + 变更数，失败可点击重试；非仓库整条隐藏。 */
export function GitBar() {
  const api = useTreeStore((state) => state.api)
  const workspaceId = useTreeStore((state) => state.activeWorkspaceId)
  const snapshot = useGitStore((state) => state.snapshot)
  const loading = useGitStore((state) => state.loading)
  const error = useGitStore((state) => state.error)
  const clearError = useGitStore((state) => state.clearError)

  if (!workspaceId || (!snapshot && !error)) return null

  const retry = (): void => {
    clearError()
    void useGitStore.getState().refresh(api, workspaceId)
  }

  if (error) {
    return (
      <button type="button" className="wsx-git-bar wsx-git-bar--error" onClick={retry}>
        git 状态获取失败，点击重试
      </button>
    )
  }

  if (!snapshot) return null
  const branchLabel = snapshot.branch ?? 'detached'
  const dirty = snapshot.changes.filter((change) => change.kind === 'file').length
  return (
    <button
      type="button"
      className="wsx-git-bar"
      onClick={retry}
      title={snapshot.upstream ? `${branchLabel} → ${snapshot.upstream}，+${snapshot.additions}/-${snapshot.deletions}` : `+${snapshot.additions}/-${snapshot.deletions}`}
    >
      <span className="wsx-git-branch">{branchLabel}</span>
      {snapshot.upstream ? <span className="wsx-git-upstream">→ {snapshot.upstream}</span> : null}
      <span className="wsx-git-count">{loading ? '…' : `${dirty} 变更 +${snapshot.additions}/-${snapshot.deletions}`}</span>
    </button>
  )
}
