import { useSshStore } from '../ssh-context'
import type { ConnectionMetrics } from '../store/ssh-store'
import {
  latencyText,
  loadPercent,
  memoryPercent,
  memoryText,
  percentText,
  sampledAtText,
} from '../resource-metrics'

/**
 * 设备资源面板：只列当前有 live 终端的连接，每台设备一段 CPU 负载 / 内存 / 网络延迟，
 * 每项带最近 30 个采样的走势线。开合由状态栏的「资源」按钮控制，关闭不影响轮询，
 * 状态栏仍要显示缩略指标。
 */
export function ResourcePanel() {
  const connections = useSshStore((state) => state.connections)
  const terminals = useSshStore((state) => state.terminals)
  const metricsByConnection = useSshStore((state) => state.metricsByConnection)
  const refreshMetrics = useSshStore((state) => state.refreshMetrics)
  const setResourcesOpen = useSshStore((state) => state.setResourcesOpen)

  const liveIds: number[] = []
  for (const tab of terminals) {
    if (tab.state === 'live' && !liveIds.includes(tab.connectionId)) liveIds.push(tab.connectionId)
  }
  const devices = liveIds
    .map((id) => connections.find((connection) => connection.id === id))
    .filter((connection) => connection !== undefined)

  return (
    <aside className="ssh-resources" aria-label="设备资源">
      <header className="ssh-resources-head">
        <span className="ssh-resources-title">资源</span>
        <button
          type="button"
          className="ssh-resources-action"
          title="立即刷新"
          aria-label="立即刷新"
          disabled={devices.length === 0}
          onClick={() => {
            for (const id of liveIds) void refreshMetrics(id)
          }}
        >
          ↻
        </button>
        <button
          type="button"
          className="ssh-resources-action"
          title="关闭资源面板"
          aria-label="关闭资源面板"
          onClick={() => setResourcesOpen(false)}
        >
          ×
        </button>
      </header>
      <div className="ssh-resources-body">
        {devices.map((connection) => (
          <DeviceSection
            key={connection.id}
            name={connection.name}
            metrics={metricsByConnection[connection.id]}
          />
        ))}
        {devices.length === 0 ? (
          <p className="ssh-resources-empty">当前没有连接中的设备。打开一个终端会话后开始采样。</p>
        ) : null}
      </div>
    </aside>
  )
}

function DeviceSection({ name, metrics }: { name: string; metrics?: ConnectionMetrics }) {
  const sample = metrics?.sample ?? null
  const error = metrics?.error ?? null
  const history = metrics?.history ?? []

  return (
    <section className="ssh-device">
      <div className="ssh-device-head">
        <span className="ssh-device-name">{name}</span>
        {sample?.hostname ? <span className="ssh-device-host">{sample.hostname}</span> : null}
      </div>
      {error ? <p className="ssh-device-error">采样失败：{error}</p> : null}
      {sample ? (
        <>
          <MetricRow
            label="负载"
            value={percentText(loadPercent(sample))}
            detail={`1 分钟 ${sample.load1.toFixed(2)} · ${sample.cores} 核`}
            samples={history.map((point) => point.loadPercent)}
          />
          <MetricRow
            label="内存"
            value={percentText(memoryPercent(sample))}
            detail={memoryText(sample)}
            samples={history.map((point) => point.memoryPercent)}
          />
          <MetricRow
            label="延迟"
            value={latencyText(sample.latency_ms)}
            detail="ssh 通道往返"
            samples={history.map((point) => point.latencyMs)}
          />
          <p className="ssh-device-foot">采样于 {sampledAtText(sample.sampled_at)}</p>
        </>
      ) : error ? null : (
        <p className="ssh-device-pending">采样中…</p>
      )}
    </section>
  )
}

function MetricRow({
  label,
  value,
  detail,
  samples,
}: {
  label: string
  value: string
  detail: string
  samples: Array<number | null>
}) {
  return (
    <div className="ssh-metric">
      <span className="ssh-metric-label">{label}</span>
      <span className="ssh-metric-value">{value}</span>
      <span className="ssh-metric-detail">{detail}</span>
      <Sparkline samples={samples} />
    </div>
  )
}

/** 走势线：从 0 起算，缺失点跳过；不足两点时画一条中线。 */
function Sparkline({ samples }: { samples: Array<number | null> }) {
  const width = 56
  const height = 14
  const values = samples.filter((value): value is number => value !== null)
  const max = Math.max(...values, 1)
  let points = `0,${height / 2} ${width},${height / 2}`
  if (values.length >= 2) {
    const step = width / (values.length - 1)
    points = values
      .map((value, index) => {
        const x = (index * step).toFixed(1)
        const y = (height - (value / max) * height).toFixed(1)
        return `${x},${y}`
      })
      .join(' ')
  }
  return (
    <svg
      className="ssh-metric-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1} />
    </svg>
  )
}
