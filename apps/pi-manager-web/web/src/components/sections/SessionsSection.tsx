import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { LiveSession, LiveSessionsListing } from '../../api/types'
import { describeError } from '../../store/app-store'
import { EmptyState, ErrorBanner, Loading } from '../ui'

/**
 * 会话：读心跳扩展写在 <home>/state/running-sessions/ 的文件。
 * 只读展示，不启动、不切换、不取消会话。运行中的会话每 15 秒续写，
 * 页面按 5 秒轮询，切到其他分区时停轮询。
 */

const POLL_MS = 5_000

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

export function SessionsSection({ home, active }: { home: string; active: boolean }) {
  const [listing, setListing] = useState<LiveSessionsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const reload = useCallback(async () => {
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
    if (!active) return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [reload, active])

  if (error && !listing) return <ErrorBanner message={error} />
  if (!listing) return <Loading label="读取会话心跳" />

  const running = listing.sessions.filter((s) => s.status === 'running').length
  const idle = listing.sessions.length - running
  const selectedSession = listing.sessions.find((s) => s.sessionId === selected) ?? null

  return (
    <section className="section">
      <header className="section-head">
        <h1 className="section-title">会话</h1>
        <span className="section-desc">
          {running} 运行中 · {idle} 空闲 · 心跳每 15 秒续写
        </span>
        <button type="button" className="btn small" onClick={() => void reload()}>
          刷新
        </button>
      </header>

      {error ? <ErrorBanner message={error} /> : null}
      {listing.warnings.map((warning, index) => (
        <p key={index} className="section-warn">
          {warning}
        </p>
      ))}
      {!listing.pluginDetected && listing.sessions.length === 0 ? (
        <p className="section-warn">
          这个 home 的 extensions/ 下没有心跳扩展。安装 <code>extension/pi-session-heartbeat.ts</code> 后新开会话或{' '}
          <code>/reload</code>，这里才会出现会话。
        </p>
      ) : null}

      {listing.sessions.length > 0 ? (
        <>
          <table className="item-table">
            <thead>
              <tr>
                <th className="col-state">State</th>
                <th>会话</th>
                <th>位置与模型</th>
                <th className="col-size">心跳</th>
              </tr>
            </thead>
            <tbody>
              {listing.sessions.map((session) => (
                <tr
                  key={session.sessionId}
                  className={session.sessionId === selected ? 'is-selected' : undefined}
                  title={session.sessionFile ?? session.sessionId}
                  onClick={() => setSelected(session.sessionId)}
                >
                  <td className="col-state">
                    <span
                      className={`state-mark${session.status === 'running' ? ' running' : ''}`}
                      aria-label={session.status === 'running' ? '运行中' : '空闲'}
                    >
                      {session.status === 'running' ? '●' : '○'}
                    </span>
                  </td>
                  <td>
                    <div className="cell-title">{sessionLabel(session)}</div>
                    <div className="cell-sub">{session.status === 'running' ? '运行中' : '空闲'} · {session.sessionId}</div>
                  </td>
                  <td>
                    <div className="cell-title">{session.model ?? '模型未知'}</div>
                    <div className="cell-sub">{session.cwd || '（无 cwd）'}</div>
                  </td>
                  <td className="col-size">{formatAgo(session.updatedAt, listing.now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mono-dim">
            心跳目录 {listing.heartbeatDir}
            {listing.stale > 0 ? ` · 已忽略 ${listing.stale} 个失联心跳` : ''}
          </p>
        </>
      ) : (
        <EmptyState
          title="没有正在运行的 pi 会话"
          hint="新开会话或 /reload 后出现。心跳超过 60 秒没续写会被当作失联。"
        />
      )}

      {selectedSession ? (
        <div className="detail-sheet" key={selectedSession.sessionId}>
          <div className="detail-grip" aria-hidden />
          <div className="detail-body">
            <div className="detail-head">
              <h2 className="detail-title">{sessionLabel(selectedSession)}</h2>
              <span className="detail-meta">
                {selectedSession.status === 'running' ? '运行中' : '空闲'} · {selectedSession.mode} ·{' '}
                {selectedSession.sameHost ? `pid ${selectedSession.pid}` : selectedSession.host}
              </span>
            </div>
            <div className="detail-grid">
              <div className="field">
                <span className="field-label">Session</span>
                <span className="mono-dim">{selectedSession.sessionId}</span>
              </div>
              <div className="field">
                <span className="field-label">Model</span>
                <span className="mono-dim">{selectedSession.model ?? '—'}</span>
              </div>
              <div className="field">
                <span className="field-label">CWD</span>
                <span className="mono-dim">{selectedSession.cwd || '—'}</span>
              </div>
              <div className="field">
                <span className="field-label">Session file</span>
                <span className="mono-dim">{selectedSession.sessionFile ?? '（无会话文件）'}</span>
              </div>
              <div className="field">
                <span className="field-label">Parent session</span>
                <span className="mono-dim">{selectedSession.parentSessionFile ?? '—'}</span>
              </div>
              <div className="field">
                <span className="field-label">Started</span>
                <span className="mono-dim">{formatTime(selectedSession.startedAt)}</span>
              </div>
              <div className="field">
                <span className="field-label">Last beat</span>
                <span className="mono-dim">{formatTime(selectedSession.updatedAt)}</span>
              </div>
              <div className="field">
                <span className="field-label">Host</span>
                <span className="mono-dim">
                  {selectedSession.host}
                  {selectedSession.pid ? ` · pid ${selectedSession.pid}` : ''}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
