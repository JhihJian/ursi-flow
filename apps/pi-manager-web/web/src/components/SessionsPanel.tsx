import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../api/client'
import type { LiveSession, LiveSessionsListing } from '../api/types'
import { describeError } from '../store/app-store'

/**
 * 运行中的会话：独立二级侧面板（对齐 fs-web 的两级侧栏结构）。
 *
 * 一级是会话列表，二级是选中会话的详情；面板可拖动宽度、可折叠成窄条，
 * 折叠后仍显示运行中数量。数据来自心跳扩展写在 <home>/state/running-sessions/
 * 的文件，只读，不启动、不切换、不取消会话。
 */

const POLL_MS = 5_000
const WIDTH_KEY = 'pi-manager.sessions-width'
const WIDTH_DEFAULT = 300
const WIDTH_MIN = 220
const WIDTH_MAX = 560
const COLLAPSED_KEY = 'pi-manager.sessions-collapsed'

function loadWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(raw) && raw >= WIDTH_MIN && raw <= WIDTH_MAX) return raw
  } catch {
    /* ignore */
  }
  return WIDTH_DEFAULT
}

function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

function sessionLabel(session: LiveSession): string {
  return session.name || session.sessionId.slice(0, 12)
}

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown
    if (Array.isArray(raw)) return new Set(raw.filter((item): item is string => typeof item === 'string'))
  } catch {
    /* ignore */
  }
  return new Set()
}

interface CwdGroup {
  cwd: string
  sessions: LiveSession[]
  running: number
  latest: number
}

/** 按 cwd 聚合：有运行中会话的组在前，然后按最近心跳倒序。 */
function groupByCwd(sessions: LiveSession[]): CwdGroup[] {
  const map = new Map<string, LiveSession[]>()
  for (const session of sessions) {
    const key = session.cwd?.trim() || '（无 cwd）'
    const list = map.get(key)
    if (list) list.push(session)
    else map.set(key, [session])
  }
  const groups: CwdGroup[] = []
  for (const [cwd, items] of map) {
    groups.push({
      cwd,
      sessions: items,
      running: items.filter((item) => item.status === 'running').length,
      latest: Math.max(...items.map((item) => item.updatedAt)),
    })
  }
  groups.sort((a, b) => {
    if (a.running > 0 !== b.running > 0) return a.running > 0 ? -1 : 1
    if (a.latest !== b.latest) return b.latest - a.latest
    return a.cwd.localeCompare(b.cwd)
  })
  return groups
}

/** 目录名：取最后一段；根目录保留 /。 */
function cwdName(cwd: string): string {
  if (cwd === '/' || /^[A-Za-z]:[\\/]?$/.test(cwd)) return cwd
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

export function SessionsPanel({
  home,
  open,
  onToggle,
}: {
  home: string
  open: boolean
  onToggle: () => void
}) {
  const [listing, setListing] = useState<LiveSessionsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [width, setWidth] = useState(loadWidth)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const reload = useCallback(async () => {
    if (!home) return
    try {
      const data = await api.getLiveSessions(home)
      setListing(data)
      setError(null)
      setSelected((current) =>
        current && data.sessions.some((s) => s.sessionId === current)
          ? current
          : (data.sessions[0]?.sessionId ?? null),
      )
    } catch (err) {
      setError(describeError(err))
    }
  }, [home])

  useEffect(() => {
    void reload()
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [reload])

  const sessions = listing?.sessions ?? []
  const running = sessions.filter((s) => s.status === 'running').length
  const idle = sessions.length - running
  const groups = groupByCwd(sessions)
  const selectedSession = sessions.find((s) => s.sessionId === selected) ?? null

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedGroups]))
    } catch {
      /* ignore */
    }
  }, [collapsedGroups])

  function toggleGroup(cwd: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(cwd)) next.delete(cwd)
      else next.add(cwd)
      return next
    })
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    dragRef.current = { startX: event.clientX, startWidth: width }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    const next = Math.min(
      WIDTH_MAX,
      Math.max(WIDTH_MIN, dragRef.current.startWidth + (event.clientX - dragRef.current.startX)),
    )
    setWidth(next)
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      /* ignore */
    }
  }

  if (!open) {
    return (
      <aside className="sessions-panel is-collapsed" aria-label="运行中的会话">
        <button
          type="button"
          className="sessions-rail"
          title="展开运行中的会话"
          aria-expanded={false}
          onClick={onToggle}
        >
          <span className="sessions-rail-toggle" aria-hidden>«</span>
          <span className="sessions-rail-title">会话</span>
          <span className={`sessions-rail-count${running > 0 ? ' is-running' : ''}`}>
            {error ? '!' : running}
          </span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="sessions-panel" style={{ width }} aria-label="运行中的会话">
      <div className="sessions-panel-head">
        <span className="sessions-panel-title">会话</span>
        <span className="sessions-panel-count">
          {running} 运行 · {idle} 空闲
        </span>
        <button type="button" className="rail-toggle" title="刷新" onClick={() => void reload()}>
          ↻
        </button>
        <button
          type="button"
          className="rail-toggle"
          title="折叠会话面板"
          aria-expanded
          onClick={onToggle}
        >
          »
        </button>
      </div>

      {error ? <p className="sessions-panel-error">{error}</p> : null}
      {listing && listing.warnings.length > 0 ? (
        <p className="sessions-panel-warn" title={listing.warnings.join('\n')}>
          {listing.warnings.length} 条心跳读取警告
        </p>
      ) : null}

      <div className="sessions-panel-list" role="tree" aria-label="按 cwd 聚合的会话">
        {groups.length > 0 ? (
          groups.map((group) => {
            const collapsed = collapsedGroups.has(group.cwd)
            return (
              <div key={group.cwd} className="sessions-group" role="treeitem" aria-expanded={!collapsed}>
                <button
                  type="button"
                  className="sessions-group-head"
                  title={group.cwd}
                  onClick={() => toggleGroup(group.cwd)}
                >
                  <span className="sessions-group-caret" aria-hidden>{collapsed ? '▸' : '▾'}</span>
                  <span className={`sessions-dot${group.running > 0 ? ' is-running' : ''}`} aria-hidden />
                  <span className="sessions-group-main">
                    <span className="sessions-group-name">{cwdName(group.cwd)}</span>
                    <span className="sessions-group-path">{group.cwd}</span>
                  </span>
                  <span className={`sessions-group-count${group.running > 0 ? ' is-running' : ''}`}>
                    {group.running}/{group.sessions.length}
                  </span>
                </button>
                {!collapsed ? (
                  <div role="group">
                    {group.sessions.map((session) => (
                      <button
                        key={session.sessionId}
                        type="button"
                        role="treeitem"
                        aria-selected={session.sessionId === selected}
                        className={`sessions-item${session.sessionId === selected ? ' is-selected' : ''}`}
                        title={session.sessionFile ?? session.sessionId}
                        onClick={() => setSelected(session.sessionId)}
                      >
                        <span
                          className={`sessions-dot${session.status === 'running' ? ' is-running' : ''}`}
                          aria-label={session.status === 'running' ? '运行中' : '空闲'}
                        />
                        <span className="sessions-item-main">
                          <span className="sessions-item-name">{sessionLabel(session)}</span>
                          <span className="sessions-item-meta">
                            {session.model ?? '模型未知'}
                            {session.parentSessionFile ? ' · 子会话' : ''}
                          </span>
                        </span>
                        <span className="sessions-item-time">
                          {listing ? formatAgo(session.updatedAt, listing.now) : '—'}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })
        ) : (
          <p className="sessions-panel-empty">
            没有正在运行的 pi 会话。新开会话或 <code>/reload</code> 后出现。
          </p>
        )}
      </div>

      {listing && !listing.pluginDetected && sessions.length === 0 ? (
        <p className="sessions-panel-warn">
          extensions/ 下没有心跳扩展。安装 <code>extension/pi-session-heartbeat.ts</code> 后才会出现会话。
        </p>
      ) : null}

      {selectedSession ? (
        <div className="sessions-panel-detail">
          <div className="sessions-detail-head">
            <span className="sessions-detail-title">{sessionLabel(selectedSession)}</span>
            <span className="sessions-detail-status">
              {selectedSession.status === 'running' ? '运行中' : '空闲'} · {selectedSession.mode}
            </span>
          </div>
          <dl className="sessions-detail-grid">
            <dt>Session</dt>
            <dd>{selectedSession.sessionId}</dd>
            <dt>Model</dt>
            <dd>{selectedSession.model ?? '—'}</dd>
            <dt>CWD</dt>
            <dd>{selectedSession.cwd || '—'}</dd>
            <dt>Session file</dt>
            <dd>{selectedSession.sessionFile ?? '（无会话文件）'}</dd>
            <dt>Parent</dt>
            <dd>{selectedSession.parentSessionFile ?? '—'}</dd>
            <dt>Started</dt>
            <dd>{formatTime(selectedSession.startedAt)}</dd>
            <dt>Last beat</dt>
            <dd>{formatTime(selectedSession.updatedAt)}</dd>
            <dt>Host</dt>
            <dd>
              {selectedSession.host}
              {selectedSession.pid ? ` · pid ${selectedSession.pid}` : ''}
            </dd>
          </dl>
          {listing ? (
            <p className="sessions-detail-foot">
              心跳每 15 秒续写 · 超过 60 秒未续写视为失联
              {listing.stale > 0 ? ` · 已忽略 ${listing.stale} 个` : ''}
            </p>
          ) : null}
        </div>
      ) : null}

      <div
        className="sessions-resizer"
        title="拖动调整宽度"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话面板宽度"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </aside>
  )
}
