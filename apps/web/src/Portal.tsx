import { useCallback, useEffect, useState } from 'react'
import { House, LayoutTemplate, PanelLeft, Puzzle, Workflow } from 'lucide-react'
import { PageFrame } from '@ursi/ui-layout'
import { SlotContent, useSlotEntries } from '@ursi/ui-slots'
import { createPortalRegistry, type PluginDefinition, type PortalContext } from './portal-contract'
import { startPlugin, type PluginStatus } from './plugin-runtime'
import type { PortalConfig } from './portal-config'

function ActivePlugin({ definition, registry, report }: {
  definition: PluginDefinition
  registry: ReturnType<typeof createPortalRegistry>
  report: (id: string, status: PluginStatus) => void
}) {
  useEffect(() => startPlugin(definition, registry, status => report(definition.id, status)), [definition, registry, report])
  return null
}

export function Portal({ context, manifest, config, problem, preview, onStatus }: {
  context: PortalContext
  manifest: readonly PluginDefinition[]
  config: PortalConfig
  problem?: string
  preview?: boolean
  onStatus?: (id: string, status: PluginStatus) => void
}) {
  const { project } = context
  const [registry] = useState(createPortalRegistry)
  const report = useCallback((id: string, status: PluginStatus) => onStatus?.(id, status), [onStatus])
  const reportRenderError = (entryId: string) => report(entryId.split('/')[0], 'render-failed')
  const entries = useSlotEntries(registry, 'home.entries')
  const aside = useSlotEntries(registry, 'home.aside')

  return <div className="portal" onClickCapture={preview ? event => {
    if (event.target instanceof Element && event.target.closest('a[href]')) event.preventDefault()
  } : undefined}>
    {manifest.filter(plugin => config.plugins[plugin.id]).map(definition => (
      <ActivePlugin key={definition.id} definition={definition} registry={registry} report={report} />
    ))}
    <PageFrame
      skipLabel="跳到主要内容"
      header={<div className="topbar">
        <span className="brand"><span className="mark"><Workflow size={19} aria-hidden="true" /></span>{project.brand}</span>
        {!preview && <nav aria-label="门户管理" className="tools">
          <a className="tool" href="/manage/#pages"><LayoutTemplate size={17} aria-hidden="true" />页面管理</a>
          <a className="tool" href="/manage/#plugins"><Puzzle size={17} aria-hidden="true" />插件管理</a>
        </nav>}
      </div>}
      navigation={{
        label: '应用导航',
        toggle: <PanelLeft size={20} aria-hidden="true" />,
        content: <>
          <a className="nav-home" href="/" aria-current="page"><House size={17} aria-hidden="true" />项目概览</a>
          <section className="entry-list" aria-labelledby="entry-title">
            <h2 id="entry-title">应用入口</h2>
            {entries.length ? <SlotContent entries={entries} context={context} onError={reportRenderError} /> : <p className="muted">暂无应用入口</p>}
          </section>
        </>,
      }}
      main={<section className="project-intro" aria-labelledby="project-title">
        {problem && <p className="config-warning" role="alert">{problem}</p>}
        <div className="project-kicker">项目概览</div>
        <h1 id="project-title">{project.name}</h1>
        {project.description && <p>{project.description}</p>}
        <dl className="project-facts"><div><dt>项目标识</dt><dd>{project.id}</dd></div></dl>
      </section>}
      aside={aside.length ? <div className="sidebar"><SlotContent entries={aside} context={context} onError={reportRenderError} /></div> : undefined}
      asidePlacement={config.page.placement}
    />
  </div>
}
