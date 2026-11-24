import { useState } from 'react'
import { Package, Search } from 'lucide-react'
import { limits, type PortalConfig } from './portal-config'
import { pluginManifest } from './plugin-manifest'
import type { PluginStatus } from './plugin-runtime'
import { webUrl } from './project'

import { portalRegions, regionLabels } from './portal-regions'
const statusLabels = { loading: '加载中', ready: '已加载', 'load-failed': '模块加载失败', 'load-timeout': '模块加载超时', 'activation-failed': '启动失败', 'render-failed': '内容渲染失败' }

export function PluginInventory({ draft, statuses, toggle, changeUrl, previewPaused }: {
  draft: PortalConfig
  statuses: Partial<Record<string, PluginStatus>>
  previewPaused: boolean
  toggle: (id: string, enabled: boolean) => void
  changeUrl: (url: string) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const available = pluginManifest.filter(plugin => {
    if (filter === 'enabled' && !draft.plugins[plugin.id].enabled) return false
    if (filter === 'disabled' && draft.plugins[plugin.id].enabled) return false
    return `${plugin.name} ${plugin.id} ${plugin.description}`.toLowerCase().includes(query.trim().toLowerCase())
  })
  return <>
    <section className="manage-section" aria-labelledby="inventory-title">
      <div className="section-head"><h2 id="inventory-title">内置插件</h2><span>{available.length} / {pluginManifest.length}</span></div>
      <div className="inventory-toolbar">
        <label className="search-control"><Search size={16} aria-hidden="true" /><input aria-label="搜索插件" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索插件" /></label>
        <select value={filter} aria-label="筛选插件状态" onChange={event => setFilter(event.target.value)}>
          <option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option>
        </select>
      </div>
      {available.length === 0 && <p className="inventory-empty" role="status">没有匹配的插件</p>}
      <ul className="inventory">
        {available.map(plugin => {
          const { enabled, regions } = draft.plugins[plugin.id]
          const selected = portalRegions.filter(region => regions[region])
          const status = !previewPaused && enabled && selected.length ? statuses[plugin.id] : undefined
          const address = plugin.id === 'workbench' ? draft.workbenchUrl : plugin.id === 'project-links' ? draft.page.repository : undefined
          return <li key={plugin.id}>
            <div className="inventory-row">
              <Package size={20} aria-hidden="true" />
              <div><label htmlFor={`plugin-${plugin.id}`}>{plugin.name}</label><small>{plugin.description}</small></div>
              <input type="checkbox" role="switch" id={`plugin-${plugin.id}`} checked={enabled} onChange={event => toggle(plugin.id, event.target.checked)} />
            </div>
            <dl className="plugin-meta">
              <div><dt>草稿区域</dt><dd>{selected.map(region => regionLabels[region]).join('、') || '未选择'}</dd></div>
              <div><dt>预览状态</dt><dd role="status" data-state={status}>{previewPaused ? '预览暂停' : !enabled ? '已停用' : !selected.length ? '未选择区域' : status ? statusLabels[status] : '待检测'}</dd></div>
              {address !== undefined && <div><dt>目标地址</dt><dd>{webUrl(address, location.origin) ? '已配置' : address.trim() ? '格式无效' : '未配置'}</dd></div>}
            </dl>
          </li>
        })}
      </ul>
    </section>
    <section className="manage-section" aria-labelledby="workbench-config">
      <div className="section-head"><h2 id="workbench-config">Workbench 配置</h2></div>
      <label className="field">Workbench 地址<input value={draft.workbenchUrl} maxLength={limits.url} spellCheck={false} onChange={event => changeUrl(event.target.value)} /></label>
    </section>
  </>
}
