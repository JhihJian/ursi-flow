import { useEffect, useRef, useState } from 'react'
import type { FlowSummary, RoutingTraceRule } from '@/api/types'
import { chainLabel, formatBytes, formatClock, formatElapsed, formatRate } from '@/lib/format'
import { cx } from '@/lib/ui'
import { useDaeStore, type NetworkConnection } from '@/store/dae-store'

const HEIGHT_KEY = 'dae-web.detail-height'
const MIN_HEIGHT = 160
const DEFAULT_HEIGHT = 320

interface SheetView {
  title: string
  rows: Array<[string, string]>
  closable: boolean
}

/** 连接上 dae 没记录命中规则，回溯成功后用回放到的命中规则补上。 */
function ruleLabel(recorded: string | null, matched: string | null): string {
  return recorded ?? matched ?? 'dae 未记录命中规则'
}

function bytesWithRate(bytes: string | null, rate: string | null): string {
  const size = formatBytes(bytes)
  const speed = formatRate(rate)
  return speed === '-' ? size : `${size}（${speed}）`
}

function connectionView(item: NetworkConnection, matchedRule: string | null): SheetView {
  return {
    title: item.domain ?? item.dst ?? item.id,
    closable: true,
    rows: [
      ['网络', item.network.toUpperCase()],
      ['状态', item.state],
      ['进程', item.pname ?? '-'],
      ['出口', item.outbound ?? '-'],
      ['链路', chainLabel(item.chain)],
      ['规则', ruleLabel(item.rule_expression ?? item.rule_id, matchedRule)],
      ['源', item.src ?? '-'],
      ['目标', item.dst ?? '-'],
      ['开始', formatClock(item.started_at)],
      ['持续', formatElapsed(item.started_at, null)],
      ['上行', bytesWithRate(item.upload_bytes, item.upload_bytes_per_second)],
      ['下行', bytesWithRate(item.download_bytes, item.download_bytes_per_second)],
      ['观察点', `${item.observed_by} / ${item.chain_source}`],
    ],
  }
}

function flowView(item: FlowSummary, matchedRule: string | null): SheetView {
  return {
    title: item.input?.domain ?? item.input?.dst ?? item.id,
    closable: false,
    rows: [
      ['网络', item.network.toUpperCase()],
      ['状态', item.state],
      ['进程', item.pname ?? '-'],
      ['出口', item.outbound ?? '-'],
      ['链路', chainLabel(item.chain)],
      ['规则', ruleLabel(item.rule_expression ?? item.rule_id, matchedRule)],
      ['源', item.input?.src ?? '-'],
      ['目标', item.input?.dst ?? '-'],
      ['开始', formatClock(item.started_at)],
      ['持续', formatElapsed(item.started_at, item.state === 'active' ? null : item.ended_at)],
      ['规则来源', item.rule_source],
      ['观察点', `${item.observed_by} / ${item.chain_source}`],
    ],
  }
}

function useSheetHeight() {
  const [height, setHeight] = useState(() => {
    const stored = Number(window.localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT
  })

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const maxHeight = window.innerHeight - MIN_HEIGHT

    const handleMove = (moveEvent: PointerEvent) => {
      const next = Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + (startY - moveEvent.clientY)))
      setHeight(next)
    }
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      setHeight((current) => {
        window.localStorage.setItem(HEIGHT_KEY, String(current))
        return current
      })
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  const resetHeight = () => {
    setHeight(DEFAULT_HEIGHT)
    window.localStorage.setItem(HEIGHT_KEY, String(DEFAULT_HEIGHT))
  }

  return { height, beginResize, resetHeight }
}

function RuleRow({ rule }: { rule: RoutingTraceRule }) {
  return (
    <li className="trace-rule">
      <span className={cx('trace-result', `trace-result-${rule.result}`)}>{rule.result}</span>
      <span className="trace-rule-id">{rule.rule_id}</span>
      <span className="trace-expression">{rule.expression ?? '-'}</span>
    </li>
  )
}

export function DetailSheet() {
  const selected = useDaeStore((state) => state.selected)
  const select = useDaeStore((state) => state.select)
  const trace = useDaeStore((state) => state.trace)
  const tracePending = useDaeStore((state) => state.tracePending)
  const traceError = useDaeStore((state) => state.traceError)
  const runTrace = useDaeStore((state) => state.runTrace)
  const closeSelectedConnection = useDaeStore((state) => state.closeSelectedConnection)
  const { height, beginResize, resetHeight } = useSheetHeight()
  const [showAllRules, setShowAllRules] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  const selectedKind = selected?.kind
  const selectedId = selected?.item.id

  useEffect(() => {
    setShowAllRules(false)
    setActionError(null)
  }, [selectedKind, selectedId])

  if (!selected) return null

  const evaluation = trace?.evaluations[0]
  const matchedRules = evaluation?.rules.filter((rule) => rule.result === 'matched') ?? []
  const visibleRules = showAllRules ? (evaluation?.rules ?? []) : matchedRules
  const matchedRule = matchedRules[0]?.expression ?? null
  const view =
    selected.kind === 'connection'
      ? connectionView(selected.item, matchedRule)
      : flowView(selected.item, matchedRule)

  const handleClose = async () => {
    setActionError(null)
    try {
      await closeSelectedConnection()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="detail-sheet" ref={sheetRef} style={{ height }}>
      <div
        className="detail-grip"
        title="拖动调整高度，双击复位"
        onPointerDown={beginResize}
        onDoubleClick={resetHeight}
      >
        <span className="detail-grip-dots">···</span>
      </div>
      <div className="detail-doc">
        <div className="detail-heading">
          <h3 className="detail-title">{view.title}</h3>
          <div className="detail-tools">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void runTrace()}
              disabled={tracePending}
            >
              {tracePending ? '回溯中' : '回溯路由'}
            </button>
            {view.closable ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void handleClose()}>
                关闭连接
              </button>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={() => select(null)}>
              关闭
            </button>
          </div>
        </div>

        <dl className="detail-meta-grid">
          {view.rows.map(([label, value]) => (
            <div key={label} className="detail-meta-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        {actionError ? <p className="section-error">{actionError}</p> : null}
        {traceError ? <p className="section-error">{traceError}</p> : null}

        {evaluation ? (
          <div className="trace">
            <div className="trace-head">
              <span className="trace-title">
                回放结果：{evaluation.decision === 'determinate' ? '确定' : evaluation.decision}
                {evaluation.outbound ? ` · ${evaluation.outbound.toLowerCase()}` : ''}
              </span>
              {evaluation.missing_inputs.length ? (
                <span className="trace-missing">缺少输入 {evaluation.missing_inputs.join(', ')}</span>
              ) : null}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowAllRules((value) => !value)}
              >
                {showAllRules ? '只看命中' : '展开全部规则'}
              </button>
            </div>
            <ul className="trace-rules">
              {visibleRules.length === 0 ? (
                <li className="trace-rule dim">没有命中的规则，按 fallback 处理。</li>
              ) : (
                visibleRules.map((rule) => <RuleRow key={rule.rule_id} rule={rule} />)
              )}
            </ul>
          </div>
        ) : (
          <p className="detail-hint">
            回溯路由会用当前规则重放这条五元组，显示每个候选规则的判定结果。
          </p>
        )}
      </div>
    </div>
  )
}
