import { useMemo, useState } from 'react'
import { chainLabel, formatBytes, formatElapsed, formatClock } from '@/lib/format'
import { cx } from '@/lib/ui'
import { useDaeStore, type NetworkConnection } from '@/store/dae-store'

type TypeFilter = 'all' | 'tcp' | 'udp'

function matches(connection: NetworkConnection, needle: string): boolean {
  if (!needle) return true
  const haystack = [
    connection.domain ?? '',
    connection.dst,
    connection.src,
    connection.pname ?? '',
    connection.outbound ?? '',
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

export function ConnectionsSection() {
  const connections = useDaeStore((state) => state.connections)
  const meta = useDaeStore((state) => state.connectionsMeta)
  const selected = useDaeStore((state) => state.selected)
  const select = useDaeStore((state) => state.select)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [needle, setNeedle] = useState('')

  const rows = useMemo(() => {
    const normalized = needle.trim().toLowerCase()
    return connections.filter((connection) => {
      if (typeFilter !== 'all' && connection.network !== typeFilter) return false
      return matches(connection, normalized)
    })
  }, [connections, typeFilter, needle])

  const counts = useMemo(
    () => ({
      tcp: connections.filter((item) => item.network === 'tcp').length,
      udp: connections.filter((item) => item.network === 'udp').length,
    }),
    [connections],
  )

  return (
    <div className="connections">
      <div className="toolbar">
        <div className="status-targets">
          <button
            type="button"
            className={cx('status-target', typeFilter === 'all' && 'is-active')}
            onClick={() => setTypeFilter('all')}
          >
            全部 <span className="status-count">{connections.length}</span>
          </button>
          <button
            type="button"
            className={cx('status-target', typeFilter === 'tcp' && 'is-active')}
            onClick={() => setTypeFilter('tcp')}
          >
            TCP <span className="status-count">{counts.tcp}</span>
          </button>
          <button
            type="button"
            className={cx('status-target', typeFilter === 'udp' && 'is-active')}
            onClick={() => setTypeFilter('udp')}
          >
            UDP <span className="status-count">{counts.udp}</span>
          </button>
        </div>
        <input
          className="filter-input"
          placeholder="过滤域名、地址、进程或出口"
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
        />
        <span className="toolbar-meta">
          {meta?.truncated ? '结果已截断 · ' : ''}
          可见性 {meta?.visibility ?? '-'}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="empty-state">
          {connections.length === 0 ? '当前没有活跃连接。' : '没有匹配该条件的连接。'}
        </p>
      ) : (
        <table className="data-table connection-table">
          <thead>
            <tr>
              <th className="col-time">开始</th>
              <th className="col-proc">进程</th>
              <th>目标</th>
              <th className="col-outbound">出口</th>
              <th className="col-chain">链路</th>
              <th className="col-num">窗口增量</th>
              <th className="col-num">上行</th>
              <th className="col-num">下行</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((connection) => {
              const isSelected =
                selected?.kind === 'connection' && selected.item.id === connection.id
              return (
                <tr
                  key={connection.id}
                  className={cx(isSelected && 'is-selected')}
                  onClick={() => select({ kind: 'connection', item: connection })}
                >
                  <td className="col-time">{formatClock(connection.started_at)}</td>
                  <td className="col-proc">
                    <span className="proc-name">{connection.pname ?? '-'}</span>
                    <span className="proc-meta">
                      {connection.network.toUpperCase()} · {formatElapsed(connection.started_at, null)}
                    </span>
                  </td>
                  <td className="col-target">
                    <span className="target-domain">{connection.domain ?? connection.dst}</span>
                    <span className="target-address">{connection.dst}</span>
                  </td>
                  <td className="col-outbound">{connection.outbound ?? '-'}</td>
                  <td className="col-chain dim">{chainLabel(connection.chain)}</td>
                  <td className="col-num">
                    {formatBytes(connection.download_window_bytes)} ↓ /{' '}
                    {formatBytes(connection.upload_window_bytes)} ↑
                  </td>
                  <td className="col-num">{formatBytes(connection.upload_bytes)}</td>
                  <td className="col-num">{formatBytes(connection.download_bytes)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
