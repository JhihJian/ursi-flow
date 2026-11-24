import { useCallback, useEffect, useState } from 'react'
import { House, LayoutTemplate, PanelLeft, Puzzle, Workflow } from 'lucide-react'
import { PageFrame } from '@ursi/ui-layout'
import { SlotContent, useSlotEntries } from '@ursi/ui-slots'
import { createPortalRegistry, type PluginDefinition, type PortalContext } from './portal-contract'
import { startPlugin, type PluginStatus } from './plugin-runtime'
import type { PortalConfig } from './portal-config'
import type { PortalRegion } from './portal-regions'

type PortalRegistry = ReturnType<typeof createPortalRegistry>

function ActivePlugin({ definition, registry, report }: {
  definition: PluginDefinition
  registry: PortalRegistry
  report: (id: string, status: PluginStatus) => void
}) {
  useEffect(() => startPlugin(definition, registry, status => report(definition.id, status)), [definition, registry, report])
  return null
}

function useRegionEntries(registry: PortalRegistry, region: PortalRegion, config: PortalConfig) {
  return useSlotEntries(registry, region).filter(entry => {
    const settings = config.plugins[entry.id.split('/')[0]]
    return settings?.enabled && settings.regions[region] === true
  })
}

export function Portal({ context, manifest, config, problem, preview, onStatus, selectedRegion }: {
  context: PortalContext
  manifest: readonly PluginDefinition[]
  config: PortalConfig
  problem?: string
  preview?: boolean
  onStatus?: (id: string, status: PluginStatus) => void
  selectedRegion?: PortalRegion
}) {
  const { project } = context
  const [registry] = useState(createPortalRegistry)
  const report = useCallback((id: string, status: PluginStatus) => onStatus?.(id, status), [onStatus])
  const reportRenderError = (entryId: string) => report(entryId.split('/')[0], 'render-failed')
  const title = useRegionEntries(registry, 'title', config)
  const leftTop = useRegionEntries(registry, 'left-top', config)
  const leftBottom = useRegionEntries(registry, 'left-bottom', config)
  const center = useRegionEntries(registry, 'center', config)
  const right = useRegionEntries(registry, 'right', config)
  const status = useRegionEntries(registry, 'status', config)
  const content = (entries: typeof title) => <SlotContent entries={entries} context={context} onError={reportRenderError} />

  return <div className="portal" data-selected-region={selectedRegion} onClickCapture={preview ? event => {
    if (event.target instanceof Element && event.target.closest('a[href]:not(.ursi-page-frame__skip)')) event.preventDefault()
  } : undefined}>
    {manifest.filter(plugin => {
      const settings = config.plugins[plugin.id]
      return settings?.enabled && Object.values(settings.regions).includes(true)
    }).map(definition => (
      <ActivePlugin key={definition.id} definition={definition} registry={registry} report={report} />
    ))}
    <PageFrame
      skipLabel="跳到主要内容"
      header={<div className="topbar" data-portal-region="title">
        <div className="brand"><span className="mark"><Workflow size={19} aria-hidden="true" /></span>{project.brand}{content(title)}</div>
        {!preview && <nav aria-label="门户管理" className="tools">
          <a className="tool" href="/manage/#pages"><LayoutTemplate size={17} aria-hidden="true" />页面管理</a>
          <a className="tool" href="/manage/#plugins"><Puzzle size={17} aria-hidden="true" />插件管理</a>
        </nav>}
      </div>}
      navigation={{
        label: '应用导航',
        toggle: <PanelLeft size={20} aria-hidden="true" />,
        content: <div data-portal-region="left-top">
          <a className="nav-home" href="/" aria-current="page"><House size={17} aria-hidden="true" />项目概览</a>
          <section className="entry-list" aria-labelledby="entry-title">
            <h2 id="entry-title">应用入口</h2>
            {leftTop.length ? content(leftTop) : <p className="muted">暂无应用入口</p>}
          </section>
        </div>,
        bottom: leftBottom.length ? <div className="nav-extra" data-portal-region="left-bottom">{content(leftBottom)}</div> : undefined,
      }}
      main={<div data-portal-region="center">
        <section className="project-intro" aria-labelledby="project-title">
          {problem && <p className="config-warning" role="alert">{problem}</p>}
          <div className="project-kicker">项目概览</div>
          <h1 id="project-title">{project.name}</h1>
          {project.description && <p>{project.description}</p>}
          <dl className="project-facts"><div><dt>项目标识</dt><dd>{project.id}</dd></div></dl>
        </section>
        {center.length > 0 && <div className="center-extensions">{content(center)}</div>}
      </div>}
      aside={right.length ? <div className="sidebar" data-portal-region="right">{content(right)}</div> : undefined}
      footer={status.length ? <div className="portal-status" data-portal-region="status">{content(status)}</div> : undefined}
    />
  </div>
}
