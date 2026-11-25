import type { TrafficSample } from '@/api/types'
import { formatBytes, formatClock, formatDuration, formatRate } from '@/lib/format'
import { useDaeStore } from '@/store/dae-store'

/** 上行/下行速率折线，横轴按采样序号等分，纵轴按窗口内峰值归一。 */
function TrafficChart({ samples }: { samples: TrafficSample[] }) {
  if (samples.length < 2) {
    return <p className="chart-empty">采样不足，等待下一个刷新周期。</p>
  }
  const width = 640
  const height = 96
  const padding = 4
  const uploads = samples.map((sample) => Number(sample.upload_bytes_per_second) || 0)
  const downloads = samples.map((sample) => Number(sample.download_bytes_per_second) || 0)
  const peak = Math.max(1, ...uploads, ...downloads)

  const points = (values: number[]) =>
    values
      .map((value, index) => {
        const x = padding + (index / (values.length - 1)) * (width - padding * 2)
        const y = height - padding - (value / peak) * (height - padding * 2)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

  const last = samples[samples.length - 1]
  return (
    <div className="chart">
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line className="chart-axis" x1={0} y1={height - padding} x2={width} y2={height - padding} />
        <polyline className="chart-line chart-line-upload" points={points(uploads)} />
        <polyline className="chart-line chart-line-download" points={points(downloads)} />
      </svg>
      <div className="chart-legend">
        <span className="chart-legend-item">
          <i className="chart-swatch chart-swatch-download" />
          下行 {formatRate(last.download_bytes_per_second)}
        </span>
        <span className="chart-legend-item">
          <i className="chart-swatch chart-swatch-upload" />
          上行 {formatRate(last.upload_bytes_per_second)}
        </span>
        <span className="chart-legend-window">
          {formatClock(samples[0].sampled_at)} – {formatClock(last.sampled_at)}
        </span>
      </div>
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
    </div>
  )
}

export function OverviewSection() {
  const runtime = useDaeStore((state) => state.runtime)
  const outbounds = useDaeStore((state) => state.outbounds)
  const traffic = useDaeStore((state) => state.traffic)
  const memory = useDaeStore((state) => state.memory)
  const connections = useDaeStore((state) => state.connections)
  const rules = useDaeStore((state) => state.rules)

  const latestMemory = memory?.samples[memory.samples.length - 1]
  const datapath = runtime?.datapath
  const ebpf = datapath?.ebpf

  return (
    <div className="overview">
      <section className="kpi-grid">
        <Kpi
          label="下行累计"
          value={formatBytes(runtime?.traffic.bytes.download)}
          hint={runtime ? `自 ${formatClock(runtime.traffic.counter_since)}` : undefined}
        />
        <Kpi label="上行累计" value={formatBytes(runtime?.traffic.bytes.upload)} />
        <Kpi
          label="当前速率"
          value={formatRate(runtime?.traffic.rates.download_bytes_per_second)}
          hint={`上行 ${formatRate(runtime?.traffic.rates.upload_bytes_per_second)}`}
        />
        <Kpi
          label="活跃连接"
          value={String(connections.length)}
          hint={runtime ? `内核视图 ${runtime.traffic.connections.total}` : undefined}
        />
        <Kpi
          label="进程内存"
          value={latestMemory ? formatBytes(latestMemory.rss_bytes) : '-'}
          hint={latestMemory?.kernel_ebpf_bytes ? `eBPF ${formatBytes(latestMemory.kernel_ebpf_bytes)}` : undefined}
        />
        <Kpi
          label="运行时长"
          value={runtime ? formatDuration(runtime.lifecycle.uptime_seconds) : '-'}
          hint={`${rules.length} 条流量规则`}
        />
      </section>

      <section className="block">
        <div className="block-head">
          <h3 className="block-title">出口流量</h3>
          <span className="block-meta">近 {traffic?.window_seconds ?? 0}s</span>
        </div>
        <TrafficChart samples={traffic?.samples ?? []} />
      </section>

      <section className="block">
        <div className="block-head">
          <h3 className="block-title">出口</h3>
          <span className="block-meta">自 {formatClock(outbounds?.counter_since)}</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th className="col-num">活跃</th>
              <th className="col-num">累计</th>
              <th className="col-num">上行</th>
              <th className="col-num">下行</th>
              <th className="col-num">错误</th>
            </tr>
          </thead>
          <tbody>
            {(outbounds?.outbounds ?? []).map((item) => (
              <tr key={item.name}>
                <td>{item.name}</td>
                <td className="dim">{item.kind}</td>
                <td className="col-num">{item.active_connections}</td>
                <td className="col-num">{item.total_connections}</td>
                <td className="col-num">{formatBytes(item.upload_bytes)}</td>
                <td className="col-num">{formatBytes(item.download_bytes)}</td>
                <td className={item.errors === '0' ? 'col-num dim' : 'col-num danger'}>
                  {item.errors}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="block">
        <div className="block-head">
          <h3 className="block-title">数据面</h3>
          <span className="block-meta">{runtime?.generation.active_id ?? '-'}</span>
        </div>
        <dl className="kv-grid">
          <div>
            <dt>类型 / 状态</dt>
            <dd>
              {datapath?.kind ?? '-'} / {datapath?.state ?? '-'}
            </dd>
          </div>
          <div>
            <dt>eBPF 程序</dt>
            <dd>{ebpf ? `${ebpf.programs} / hooks ${ebpf.hooks}` : '-'}</dd>
          </div>
          <div>
            <dt>路由发布</dt>
            <dd>{ebpf ? `${ebpf.routing.state} · gen ${ebpf.routing.generation_id}` : '-'}</dd>
          </div>
          <div>
            <dt>健康</dt>
            <dd className={ebpf?.health === 'healthy' ? 'is-ok' : 'is-warn'}>
              {ebpf?.health ?? '-'}
            </dd>
          </div>
          <div>
            <dt>配置修订</dt>
            <dd className="mono-clip">{runtime?.generation.config_revision.slice(0, 12) ?? '-'}</dd>
          </div>
          <div>
            <dt>可见性</dt>
            <dd>{datapath?.visibility ?? '-'}</dd>
          </div>
        </dl>
        {datapath?.errors?.length ? (
          <p className="section-error">
            {datapath.errors.map((item) => item.message ?? '未知错误').join('；')}
          </p>
        ) : null}
      </section>
    </div>
  )
}
