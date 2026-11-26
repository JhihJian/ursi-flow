import { useSshStore } from '../ssh-context'
import type { ConnectionMetrics } from '../store/ssh-store'
import type { ProcessUsage } from '../api/types'
import {
  diskPercent,
  formatKb,
  formatRate,
  formatUptime,
  latencyText,
  memoryBreakdown,
  memoryPercent,
  memoryText,
  percentText,
  sampledAtText,
} from '../resource-metrics'

/**
 * 设备资源面板：只列当前有 live 终端的连接。
 * 每台设备按 orca 资源面板的组织方式展示：内存构成条、带走势线的 CPU / 内存 / 延迟 / 磁盘、
 * 内存占用最高的进程，以及采样时间。开合由状态栏的「资源」按钮控制，
 * 关闭不影响轮询，状态栏仍要显示缩略指标。
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
  const breakdown = sample ? memoryBreakdown(sample) : null
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
          <p className="ssh-device-meta">
            已运行 {formatUptime(sample.uptime_secs)}
            {sample.swap_total_kb > 0
              ? ` · 交换 ${formatKb(sample.swap_total_kb - sample.swap_free_kb)} / ${formatKb(sample.swap_total_kb)}`
              : ''}
          </p>
          {breakdown ? (
            <>
              <div className="ssh-memory-bar" aria-hidden="true">
                <span className="ssh-memory-used" style={{ width: `${breakdown.usedPercent}%` }} />
                <span className="ssh-memory-cache" style={{ width: `${breakdown.cachePercent}%` }} />
              </div>
              <p className="ssh-memory-legend">
                <span>
                  <i className="used" aria-hidden="true" />
                  已用 {formatKb(breakdown.usedKb)}
                </span>
                <span>
                  <i className="cache" aria-hidden="true" />
                  缓存 {formatKb(breakdown.cacheKb)}
                </span>
                <span>
                  <i className="free" aria-hidden="true" />
                  空闲 {formatKb(breakdown.freeKb)}
                </span>
              </p>
            </>
          ) : null}
          <MetricRow
            label="CPU"
            value={percentText(sample.cpu_percent)}
            detail={`负载 ${sample.load1.toFixed(2)} / ${sample.load5.toFixed(2)} / ${sample.load15.toFixed(2)} · ${sample.cores} 核`}
            samples={history.map((point) => point.cpuPercent)}
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
            detail={`收 ${formatRate(metrics?.throughput?.rxBps ?? null)} · 发 ${formatRate(metrics?.throughput?.txBps ?? null)}`}
            samples={history.map((point) => point.latencyMs)}
          />
          {sample.disk ? (
            <MetricRow
              label="磁盘"
              value={percentText(diskPercent(sample))}
              detail={`${formatKb(sample.disk.used_kb)} / ${formatKb(sample.disk.total_kb)} · /`}
            />
          ) : null}
          {sample.processes.length > 0 ? <ProcessList processes={sample.processes} /> : null}
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
  samples?: Array<number | null>
}) {
  return (
    <div className="ssh-metric">
      <span className="ssh-metric-label">{label}</span>
      <span className="ssh-metric-value">{value}</span>
      <span className="ssh-metric-detail">{detail}</span>
      {samples ? <Sparkline samples={samples} /> : null}
    </div>
  )
}

function ProcessList({ processes }: { processes: ProcessUsage[] }) {
  return (
    <div className="ssh-processes">
      <div className="ssh-processes-title">进程 · 内存前 {processes.length}</div>
      {processes.map((process) => (
        <div className="ssh-process-row" key={process.pid}>
          <span className="ssh-process-name" title={`${process.name}（pid ${process.pid}）`}>
            {process.name}
          </span>
          <span className="ssh-process-rss">{formatKb(process.rss_kb)}</span>
          <span className="ssh-process-mem">{process.mem_percent.toFixed(1)}%</span>
        </div>
      ))}
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
