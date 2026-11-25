import { useEffect, useState } from 'react'
import { useTreeStore } from './tree-store.ts'
import { useGitStore } from './git-store.ts'

/** 侧栏底部 git 同步状态条：推送/拉取进行中显示进度条与实时耗时；
 *  失败显示错误（点击关闭，非阻断——失败后快照已刷新）。空闲时不渲染。 */
export function GitSyncStatus() {
  const workspaceId = useTreeStore((state) => state.activeWorkspaceId)
  const phase = useGitStore((state) => state.sync.phase)
  const startedAt = useGitStore((state) => state.sync.startedAt)
  const error = useGitStore((state) => state.sync.error)
  const clearSyncError = useGitStore((state) => state.clearSyncError)
  // 进度条用不定态动画（无真实进度可报），耗时每 100ms 走一次
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!phase) return
    setElapsed(Date.now() - startedAt)
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 100)
    return () => window.clearInterval(timer)
  }, [phase, startedAt])

  if (!workspaceId) return null
  if (error) {
    return (
      <button
        type="button"
        className="wsx-git-sync-status wsx-git-sync-status--error"
        onClick={clearSyncError}
        title={`${error}（点击关闭）`}
      >
        同步失败：{error}
      </button>
    )
  }
  if (!phase) return null
  const label = phase === 'push' ? '推送中' : '拉取中'
  const seconds = (elapsed / 1000).toFixed(1)
  return (
    <div className="wsx-git-sync-status">
      <span className="wsx-git-sync-label">{label}</span>
      <span className="wsx-git-sync-progress" />
      <span className="wsx-git-sync-elapsed">{seconds}s</span>
    </div>
  )
}
