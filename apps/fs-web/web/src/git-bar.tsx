import { useTreeStore } from './tree-store.ts'
import { useGitStore } from './git-store.ts'

/** 侧栏 git 摘要：分支/变更 chip 徽标串（对齐 todo-web status-target 风格），
 *  点击刷新；失败显示错误 chip；非仓库整条隐藏。 */
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
      <div className="wsx-git-bar">
        <button type="button" className="wsx-git-chip wsx-git-chip--error" onClick={retry}>
          git 状态获取失败，点击重试
        </button>
      </div>
    )
  }

  if (!snapshot) return null
  const branchLabel = snapshot.branch ?? 'detached'
  const dirty = snapshot.changes.filter((change) => change.kind === 'file').length
  return (
    <div className="wsx-git-bar">
      <button
        type="button"
        className="wsx-git-chip wsx-git-chip--branch"
        onClick={retry}
        title={snapshot.upstream ? `${branchLabel} → ${snapshot.upstream}` : branchLabel}
      >
        {loading ? '…' : branchLabel}
      </button>
      {snapshot.upstream ? (
        <span className="wsx-git-chip wsx-git-upstream" title={snapshot.upstream}>
          → {snapshot.upstream}
        </span>
      ) : null}
      <button
        type="button"
        className="wsx-git-chip"
        onClick={retry}
        title={`+${snapshot.additions}/-${snapshot.deletions}，点击刷新`}
      >
        {dirty} 变更 +{snapshot.additions}/-{snapshot.deletions}
      </button>
    </div>
  )
}
