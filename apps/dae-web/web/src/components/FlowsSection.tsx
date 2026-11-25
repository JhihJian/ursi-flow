import { useMemo, useState } from 'react'
import type { FlowSummary } from '@/api/types'
import { chainLabel, formatDuration, formatElapsed, formatClock } from '@/lib/format'
import { cx } from '@/lib/ui'
import { useDaeStore } from '@/store/dae-store'

function networkOf(flow: FlowSummary): 'tcp' | 'udp' {
  return flow.network === 'udp' ? 'udp' : 'tcp'
}

function matches(flow: FlowSummary, needle: string): boolean {
  if (!needle) return true
  const haystack = [
    flow.pname ?? '',
    flow.input?.domain ?? '',
    flow.input?.dst ?? '',
    flow.outbound ?? '',
    flow.rule_expression ?? '',
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

export function FlowsSection() {
  const flows = useDaeStore((state) => state.flows)
  const selected = useDaeStore((state) => state.selected)
  const select = useDaeStore((state) => state.select)
  const [network, setNetwork] = useState<'all' | 'tcp' | 'udp'>('all')
  const [state, setState] = useState<'all' | 'active' | 'closed'>('all')
  const [needle, setNeedle] = useState('')

  const rows = useMemo(() => {
    const normalized = needle.trim().toLowerCase()
    return flows.filter((flow) => {
      if (network !== 'all' && networkOf(flow) !== network) return false
      if (state !== 'all' && flow.state !== state) return false
      return matches(flow, normalized)
    })
  }, [flows, network, state, needle])

  return (
    <div className="flows">
      <div className="toolbar">
        <div className="status-targets">
          {(['all', 'active', 'closed'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={cx('status-target', state === value && 'is-active')}
              onClick={() => setState(value)}
            >
              {value === 'all' ? '全部' : value === 'active' ? '进行中' : '已关闭'}
            </button>
          ))}
        </div>
        <select
          className="control-select"
          value={network}
          onChange={(event) => setNetwork(event.target.value as 'all' | 'tcp' | 'udp')}
        >
          <option value="all">TCP + UDP</option>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
        </select>
        <input
          className="filter-input"
          placeholder="过滤域名、地址、进程或出口"
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <p className="empty-state">
          {flows.length === 0 ? '近期没有流记录，dae 重启后记录会清空。' : '没有匹配该条件的流记录。'}
        </p>
      ) : (
        <table className="data-table flow-table">
          <thead>
            <tr>
              <th className="col-time">开始</th>
              <th className="col-num">时长</th>
              <th className="col-net">网络</th>
              <th className="col-proc">进程</th>
              <th>目标</th>
              <th className="col-outbound">出口</th>
              <th className="col-chain">链路</th>
              <th className="col-state">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((flow) => {
              const isSelected = selected?.kind === 'flow' && selected.item.id === flow.id
              return (
                <tr
                  key={flow.id}
                  className={cx(isSelected && 'is-selected')}
                  onClick={() => select({ kind: 'flow', item: flow })}
                >
                  <td className="col-time">{formatClock(flow.started_at)}</td>
                  <td className="col-num">
                    {formatElapsed(flow.started_at, flow.state === 'active' ? null : flow.ended_at)}
                  </td>
                  <td className="col-net">{networkOf(flow).toUpperCase()}</td>
                  <td className="col-proc">{flow.pname ?? '-'}</td>
                  <td className="col-target">
                    <span className="target-domain">{flow.input?.domain ?? flow.input?.dst ?? '-'}</span>
                    <span className="target-address">{flow.input?.dst ?? '-'}</span>
                  </td>
                  <td className="col-outbound">{flow.outbound ?? '-'}</td>
                  <td className="col-chain dim">{chainLabel(flow.chain)}</td>
                  <td className={cx('col-state', flow.state === 'closed' ? 'dim' : 'is-ok')}>
                    {flow.state}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="footnote">
        流记录只保留在 dae 进程内存中：上限 2048 条，保留 {formatDuration(900)}。
      </p>
    </div>
  )
}
