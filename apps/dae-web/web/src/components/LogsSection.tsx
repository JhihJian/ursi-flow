import { useEffect, useRef, useState } from 'react'
import type { LogRecord } from '@/api/types'
import { formatClock } from '@/lib/format'
import { cx } from '@/lib/ui'
import { daeActions, useDaeStore } from '@/store/dae-store'

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const

/** 日志走 dae 的 SSE 通道，切换级别时重开连接。 */
export function LogsSection() {
  const level = useDaeStore((state) => state.logLevel)
  const setLogLevel = useDaeStore((state) => state.setLogLevel)
  const logs = useDaeStore((state) => state.logs)
  const clearLogs = useDaeStore((state) => state.clearLogs)
  const [streamState, setStreamState] = useState<'connecting' | 'open' | 'error'>('connecting')
  const [follow, setFollow] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setStreamState('connecting')
    const source = new EventSource(`/api/v1/logs?level=${encodeURIComponent(level)}`)
    source.addEventListener('log', (event) => {
      try {
        daeActions.appendLog(JSON.parse((event as MessageEvent).data) as LogRecord)
      } catch {
        // 单帧解析失败不影响后续日志。
      }
    })
    source.addEventListener('stream.ready', () => setStreamState('open'))
    source.onopen = () => setStreamState('open')
    source.onerror = () => setStreamState('error')
    return () => source.close()
  }, [level])

  useEffect(() => {
    if (!follow) return
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [logs, follow])

  return (
    <div className="logs">
      <div className="toolbar">
        <select
          className="control-select"
          value={level}
          onChange={(event) => setLogLevel(event.target.value)}
        >
          {LEVELS.map((item) => (
            <option key={item} value={item}>
              {item} 及以上
            </option>
          ))}
        </select>
        <span className={cx('stream-state', streamState)}>
          {streamState === 'open' ? '已连接' : streamState === 'connecting' ? '连接中' : '已断开'}
        </span>
        <label className="check">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />
          跟随最新
        </label>
        <span className="toolbar-meta">{logs.length} 行</span>
        <button type="button" className="btn btn-sm" onClick={clearLogs}>
          清空
        </button>
      </div>

      <div className="log-list" ref={listRef}>
        {logs.length === 0 ? (
          <p className="empty-state">等待日志输出。</p>
        ) : (
          logs.map((record, index) => (
            <div className="log-line" key={`${record.ts}-${index}`}>
              <span className="log-time">{formatClock(record.ts)}</span>
              <span className={cx('log-level', `log-level-${record.level}`)}>{record.level}</span>
              <span className="log-message">{record.message}</span>
              {record.target ? <span className="log-target">{record.target}</span> : null}
            </div>
          ))
        )}
      </div>
      <p className="footnote">日志只在 dae 进程内存中保留最近 300 秒，服务重启后清空。</p>
    </div>
  )
}
