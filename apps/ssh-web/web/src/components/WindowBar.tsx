import { useEffect } from 'react'
import { useSshStore } from '../ssh-context'
import type { TerminalTab } from '../store/ssh-store'

/** 轮询间隔：远端在终端里开/关 window 也能较快反映到条上。 */
const WINDOWS_POLL_MS = 10_000

/**
 * 激活终端的 window 条：把远端 tmux 会话内的 window（tmux 状态栏里的「标签」）
 * 平铺为可点击的标签。点击即切换会话当前 window（attach 中的终端立刻换画面），
 * `+` 新建，`×` 关闭（其中窗格进程一并结束）。
 * 仅远端有 tmux 的激活标签渲染；回退普通 shell 或已结束的标签不渲染。
 */
export function WindowBar({ tab }: { tab: TerminalTab }) {
  const windowsState = useSshStore((state) => state.windowsByTab[tab.key])
  const refreshTmuxWindows = useSshStore((state) => state.refreshTmuxWindows)
  const selectTmuxWindow = useSshStore((state) => state.selectTmuxWindow)
  const createTmuxWindow = useSshStore((state) => state.createTmuxWindow)
  const killTmuxWindow = useSshStore((state) => state.killTmuxWindow)

  const connectionId = tab.connectionId
  // 默认入口 main 对应远端会话 ssh-main；其余标签 key 即会话名。
  const session = tab.tmuxSession ?? 'ssh-main'
  const live = tab.state === 'live'

  useEffect(() => {
    if (!live) return
    let cancelled = false
    const tick = (): void => {
      if (!cancelled) void refreshTmuxWindows(tab.key, connectionId, session)
    }
    tick()
    const timer = setInterval(tick, WINDOWS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [live, tab.key, connectionId, session, refreshTmuxWindows])

  const windows = windowsState?.windows ?? []
  // 列表为空的三种可能：还没拉到、远端无 tmux（windows null 落成 []）、会话没了。
  // 前两种不该占一条空栏，统一不渲染；有 error 时短暂提示。
  if (!live || (windows.length === 0 && !windowsState?.error)) return null

  return (
    <div className="ssh-window-bar" role="tablist" aria-label="tmux window 列表">
      {windows.map((window) => (
        <span
          key={window.index}
          className={window.active ? 'ssh-window-item active' : 'ssh-window-item'}
          title={`${window.name}（${window.panes} 窗格）`}
          onClick={() => void selectTmuxWindow(tab.key, connectionId, session, window.index)}
        >
          <span className="ssh-window-index">{window.index}</span>
          <span className="ssh-window-name">{window.name}</span>
          <button
            type="button"
            className="ssh-window-close"
            aria-label={`关闭 window ${window.index}`}
            title="关闭 window（其中进程一并结束）"
            onClick={(event) => {
              event.stopPropagation()
              void killTmuxWindow(tab.key, connectionId, session, window.index)
            }}
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        className="ssh-window-new"
        aria-label="新建 window"
        title="新建 window"
        onClick={() => void createTmuxWindow(tab.key, connectionId, session)}
      >
        +
      </button>
      {windowsState?.error ? (
        <span className="ssh-window-error" title={windowsState.error}>
          window 列表获取失败
        </span>
      ) : null}
    </div>
  )
}
