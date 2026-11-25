import { useTreeStore } from './tree-store.ts'
import { useGitStore } from './git-store.ts'

/** 侧栏 git 摘要：分支 chip + 变更徽标 + 推送/拉取按钮。
 *  ↑N 表示待推送（领先 upstream 的提交数），点击推送；↓M 表示待拉取，点击拉取。
 *  无 upstream 或数量为 0 时按钮禁用；同步失败在状态条显示错误，点击可关闭。 */
export function GitBar() {
  const api = useTreeStore((state) => state.api)
  const workspaceId = useTreeStore((state) => state.activeWorkspaceId)
  const snapshot = useGitStore((state) => state.snapshot)
  const loading = useGitStore((state) => state.loading)
  const error = useGitStore((state) => state.error)
  const syncPhase = useGitStore((state) => state.sync.phase)
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
  // detached / 无 upstream 时不可同步；同步进行中禁用两个按钮
  const syncable = Boolean(snapshot.branch && snapshot.upstream) && !syncPhase
  const canPush = syncable && snapshot.ahead > 0
  const canPull = syncable && snapshot.behind > 0
  const upstreamTitle = snapshot.upstream ? `${branchLabel} → ${snapshot.upstream}` : branchLabel
  return (
    <div className="wsx-git-bar">
      <button
        type="button"
        className="wsx-git-chip wsx-git-chip--branch"
        onClick={retry}
        title={`${upstreamTitle}，点击刷新`}
      >
        {loading ? '…' : branchLabel}
      </button>
      <button
        type="button"
        className="wsx-git-chip"
        onClick={retry}
        title={`+${snapshot.additions}/-${snapshot.deletions}，点击刷新`}
      >
        {dirty} 变更 +{snapshot.additions}/-{snapshot.deletions}
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
  )
}
