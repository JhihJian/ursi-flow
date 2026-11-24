import { portalRegions, regionLabels, type PortalRegion } from './portal-regions'
import { pluginManifest } from './plugin-manifest'
import type { PortalConfig } from './portal-config'

export function RegionEditor({ draft, region, select, toggle }: {
  draft: PortalConfig
  region: PortalRegion
  select: (region: PortalRegion) => void
  toggle: (id: string, enabled: boolean) => void
}) {
  const eligible = pluginManifest.filter(plugin => Object.hasOwn(plugin.placements, region))
  return <section className="manage-section" aria-labelledby="region-layout-title">
    <div className="section-head"><h2 id="region-layout-title">六区布局</h2><code>/</code></div>
    <div className="region-map" role="group" aria-label="页面区域">
      {portalRegions.map(id => {
        const count = Object.values(draft.plugins).filter(plugin => plugin.enabled && plugin.regions[id]).length
        return <button key={id} type="button" data-region={id} aria-pressed={region === id} aria-label={regionLabels[id]} onClick={() => select(id)}>
          <span>{regionLabels[id]}</span><span className="region-count" aria-hidden="true">{count}</span>
        </button>
      })}
    </div>
    <div className="region-settings">
      <h3>{regionLabels[region]} · 插件贡献</h3>
      {eligible.length === 0 && <p className="muted">暂无插件登记到此区域</p>}
      <ul className="inventory">
        {eligible.map(plugin => {
          const settings = draft.plugins[plugin.id]
          return <li key={plugin.id}>
            <div className="region-row">
              <label htmlFor={`region-${plugin.id}`}>{plugin.name}{!settings.enabled && <small>整站已停用</small>}</label>
              <input type="checkbox" role="switch" id={`region-${plugin.id}`} checked={settings.regions[region] ?? false} onChange={event => toggle(plugin.id, event.target.checked)} />
            </div>
          </li>
        })}
      </ul>
    </div>
  </section>
}
