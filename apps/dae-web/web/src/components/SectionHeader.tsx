import type { Section } from '@/api/types'
import { formatClock } from '@/lib/format'
import { cx } from '@/lib/ui'
import { useDaeStore } from '@/store/dae-store'

const TITLES: Record<Section, { title: string; subtitle: string }> = {
  overview: { title: '运行概览', subtitle: 'dae 进程、数据面与出口计数' },
  connections: { title: '活跃连接', subtitle: '当前经过 dae 的 TCP / UDP 会话' },
  flows: { title: '流历史', subtitle: '近期流记录，含已关闭会话' },
  rules: { title: '分流规则', subtitle: '流量规则与 DNS 路由规则' },
  dns: { title: 'DNS 观测', subtitle: '解析日志与本地缓存' },
  logs: { title: '运行日志', subtitle: '实时日志输出，按级别过滤' },
  config: { title: '配置', subtitle: '编辑 dae 配置，校验后热加载' },
}

function subtitleFor(section: Section, counts: Record<string, number>): string {
  const base = TITLES[section].subtitle
  switch (section) {
    case 'connections':
      return `${base} · ${counts.connections ?? 0} 条`
    case 'flows':
      return `${base} · ${counts.flows ?? 0} 条`
    case 'rules':
      return `${base} · ${counts.rules ?? 0} 条`
    case 'dns':
      return `${base} · ${counts.dns ?? 0} 次解析 / ${counts.cache ?? 0} 条缓存`
    default:
      return base
  }
}

/** 看板顶栏：标题、数据来源摘要与刷新控制，滚动时吸顶。 */
export function SectionHeader() {
  const section = useDaeStore((state) => state.section)
  const paused = useDaeStore((state) => state.paused)
  const tickSeconds = useDaeStore((state) => state.tickSeconds)
  const loading = useDaeStore((state) => state.loading)
  const error = useDaeStore((state) => state.error)
  const updatedAt = useDaeStore((state) => state.updatedAt)
  const togglePaused = useDaeStore((state) => state.togglePaused)
  const setTickSeconds = useDaeStore((state) => state.setTickSeconds)
  const refresh = useDaeStore((state) => state.refresh)

  const connections = useDaeStore((state) => state.connections.length)
  const flows = useDaeStore((state) => state.flows.length)
  const rules = useDaeStore((state) => state.rules.length)
  const dnsLogTotal = useDaeStore((state) => state.dnsLogTotal)
  const dnsCacheTotal = useDaeStore((state) => state.dnsCacheTotal)

  const meta = TITLES[section]

  return (
    <header className="section-header">
      <div className="section-heading">
        <h2 className="section-title">{meta.title}</h2>
        <p className="section-subtitle">
          {subtitleFor(section, {
            connections,
            flows,
            rules,
            dns: dnsLogTotal,
            cache: dnsCacheTotal,
          })}
        </p>
      </div>
      <div className="section-controls">
        <span className={cx('live-dot', loading && 'is-busy', paused && 'is-paused')} />
        <span className="updated-at">{updatedAt ? formatClock(new Date(updatedAt).toISOString()) : '-'}</span>
        <select
          className="control-select"
          value={tickSeconds}
          onChange={(event) => setTickSeconds(Number(event.target.value))}
          title="自动刷新间隔"
        >
          <option value={2}>2s</option>
          <option value={3}>3s</option>
          <option value={5}>5s</option>
          <option value={10}>10s</option>
        </select>
        <button type="button" className="btn btn-sm" onClick={togglePaused}>
          {paused ? '继续' : '暂停'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void refresh()}
          disabled={loading}
        >
          刷新
        </button>
      </div>
      {error ? <p className="section-error">{error}</p> : null}
    </header>
  )
}
