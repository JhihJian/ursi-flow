import type { Section } from '@/api/types'
import { cx } from '@/lib/ui'
import { useDaeStore } from '@/store/dae-store'

const NAV: Array<{ id: Section; label: string; hint: string }> = [
  { id: 'overview', label: '概览', hint: '运行态与出口' },
  { id: 'connections', label: '连接', hint: '活跃连接' },
  { id: 'flows', label: '流历史', hint: '近期记录' },
  { id: 'rules', label: '规则', hint: '分流与 DNS' },
  { id: 'dns', label: 'DNS', hint: '解析与缓存' },
  { id: 'logs', label: '日志', hint: '实时输出' },
]

function useNavCounts(): Record<Section, string> {
  const connections = useDaeStore((state) => state.connections.length)
  const flows = useDaeStore((state) => state.flows.length)
  const rules = useDaeStore((state) => state.rules.length)
  const dnsLogTotal = useDaeStore((state) => state.dnsLogTotal)
  const logs = useDaeStore((state) => state.logs.length)
  return {
    overview: '',
    connections: String(connections),
    flows: String(flows),
    rules: String(rules),
    dns: String(dnsLogTotal),
    logs: String(logs),
  }
}

/** 侧栏只放分区导航与 dae 健康摘要，具体数据在看板内展示。 */
export function Sidebar({
  collapsed,
  onCollapse,
  onExpand,
}: {
  collapsed: boolean
  onCollapse: () => void
  onExpand: () => void
}) {
  const section = useDaeStore((state) => state.section)
  const setSection = useDaeStore((state) => state.setSection)
  const version = useDaeStore((state) => state.version)
  const runtime = useDaeStore((state) => state.runtime)
  const counts = useNavCounts()
  const current = NAV.find((item) => item.id === section) ?? NAV[0]

  if (collapsed) {
    return (
      <div className="sidebar-collapsed">
        <button type="button" className="rail-toggle" title="展开导航" onClick={onExpand}>
          ›
        </button>
        <button type="button" className="collapsed-section" title={current.label} onClick={onExpand}>
          <span className="collapsed-section-name">{current.label}</span>
          {counts[current.id] ? (
            <span className="collapsed-section-meta">{counts[current.id]}</span>
          ) : null}
        </button>
      </div>
    )
  }

  const uptime = runtime ? `${Math.floor(Number(runtime.lifecycle.uptime_seconds) / 60)}m` : '-'
  const datapathState = runtime?.datapath.state ?? '-'

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <h1 className="sidebar-title">dae</h1>
        <button type="button" className="rail-toggle" title="折叠导航" onClick={onCollapse}>
          ‹
        </button>
      </div>
      <ul className="nav-list">
        {NAV.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={cx('nav-item', item.id === section && 'active')}
              onClick={() => setSection(item.id)}
            >
              <span className="nav-item-main">
                <span className="name">{item.label}</span>
                {counts[item.id] ? <span className="count">{counts[item.id]}</span> : null}
              </span>
              <span className="meta">{item.hint}</span>
            </button>
          </li>
        ))}
      </ul>
      <dl className="sidebar-status">
        <div>
          <dt>版本</dt>
          <dd>{version ? version.engine.version : '-'}</dd>
        </div>
        <div>
          <dt>运行</dt>
          <dd>{uptime}</dd>
        </div>
        <div>
          <dt>数据面</dt>
          <dd className={cx('datapath', datapathState === 'active' ? 'is-ok' : 'is-warn')}>
            {datapathState}
          </dd>
        </div>
      </dl>
    </div>
  )
}
