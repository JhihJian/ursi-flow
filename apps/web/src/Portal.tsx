import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Boxes, Columns2, PanelsTopLeft, Puzzle, Rows2, Workflow, X } from 'lucide-react'
import { PageFrame } from '@ursi/ui-layout'
import { SlotContent, useSlotEntries } from '@ursi/ui-slots'
import { createPortalRegistry, type PluginDefinition, type PortalContext } from './portal-contract'
import { startPlugin, type PluginStatus } from './plugin-runtime'
import { readStoredPreferences, writePreferences, type Placement } from './preferences'

function SettingsDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} aria-labelledby={titleId} onClose={onClose}>
    <header className="dialog-title">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="tool icon-tool" onClick={() => ref.current?.close()} title="关闭" aria-label="关闭"><X size={18} /></button>
    </header>
    {children}
  </dialog>
}

function ActivePlugin({ definition, registry, report }: {
  definition: PluginDefinition
  registry: ReturnType<typeof createPortalRegistry>
  report: (id: string, status: PluginStatus) => void
}) {
  useEffect(() => startPlugin(definition, registry, status => report(definition.id, status)), [definition, registry, report])
  return null
}

const labels = { loading: '加载中', ready: '已加载', 'load-failed': '加载失败，请刷新页面', 'activation-failed': '启动失败' }

export function Portal({ context, manifest }: { context: PortalContext; manifest: readonly PluginDefinition[] }) {
  const { project } = context
  const [registry] = useState(createPortalRegistry)
  const [dialog, setDialog] = useState<'layout' | 'plugins' | null>(null)
  const [preferences, setPreferences] = useState(() => readStoredPreferences(project.id, manifest))
  const [pluginState, setPluginState] = useState<Partial<Record<string, PluginStatus>>>({})
  const [attempts, setAttempts] = useState<Partial<Record<string, number>>>({})
  const report = useCallback((id: string, status: PluginStatus) => {
    setPluginState(previous => ({ ...previous, [id]: status }))
  }, [])
  const entries = useSlotEntries(registry, 'home.entries')
  const aside = useSlotEntries(registry, 'home.aside')
  const enabled = (plugin: PluginDefinition) => preferences.plugins[plugin.id] ?? plugin.enabledByDefault
  const changePlacement = (placement: Placement) => setPreferences(previous => ({ ...previous, placement }))

  useEffect(() => writePreferences(project.id, preferences), [project.id, preferences])

  return <>
    {manifest.filter(enabled).map(definition => (
      <ActivePlugin key={`${definition.id}:${attempts[definition.id] ?? 0}`} definition={definition} registry={registry} report={report} />
    ))}
    <PageFrame
      skipLabel="跳到主要内容"
      header={<div className="topbar">
        <span className="brand"><span className="mark"><Workflow size={19} aria-hidden="true" /></span>{project.brand}</span>
        <nav aria-label="首页设置" className="tools">
          <button type="button" className="tool" onClick={() => setDialog('layout')}><PanelsTopLeft size={17} aria-hidden="true" />布局设置</button>
          <button type="button" className="tool" onClick={() => setDialog('plugins')}><Puzzle size={17} aria-hidden="true" />插件管理</button>
        </nav>
      </div>}
      main={<>
        <section className="project-intro" aria-labelledby="project-title">
          <div className="project-kicker"><Boxes size={18} aria-hidden="true" /> 项目</div>
          <h1 id="project-title">{project.name}</h1>
          <p>{project.description}</p>
        </section>
        <section className="entry-list" aria-labelledby="entry-title">
          <h2 id="entry-title">应用入口</h2>
          {entries.length ? <SlotContent entries={entries} context={context} /> : <p className="muted">暂无应用入口</p>}
        </section>
      </>}
      aside={aside.length ? <div className="sidebar" aria-label="项目侧栏"><SlotContent entries={aside} context={context} /></div> : undefined}
      asidePlacement={preferences.placement}
    />
    {dialog === 'layout' && <SettingsDialog title="布局设置" onClose={() => setDialog(null)}>
      <fieldset>
        <legend>扩展区域位置</legend>
        <div className="placement">
          <label><input type="radio" name="placement" checked={preferences.placement === 'right'} onChange={() => changePlacement('right')} /><Columns2 size={18} aria-hidden="true" /> 右侧</label>
          <label><input type="radio" name="placement" checked={preferences.placement === 'below'} onChange={() => changePlacement('below')} /><Rows2 size={18} aria-hidden="true" /> 下方</label>
        </div>
      </fieldset>
      <button type="button" className="tool secondary" onClick={() => changePlacement('right')}>恢复默认</button>
    </SettingsDialog>}
    {dialog === 'plugins' && <SettingsDialog title="插件管理" onClose={() => setDialog(null)}>
      <ul className="plugin-list">
        {manifest.map(plugin => {
          const status = enabled(plugin) ? (pluginState[plugin.id] ?? 'loading') : null
          return <li key={plugin.id}>
            <div><label htmlFor={`plugin-${plugin.id}`}>{plugin.name}</label><small>{plugin.description}</small></div>
            <span className="plugin-status" role="status">{status ? labels[status] : '已停用'}</span>
            {status === 'activation-failed' && <button type="button" className="tool" aria-label={`重试 ${plugin.name}`} onClick={() => setAttempts(previous => ({ ...previous, [plugin.id]: (previous[plugin.id] ?? 0) + 1 }))}>重试</button>}
            <input id={`plugin-${plugin.id}`} type="checkbox" role="switch" checked={enabled(plugin)} onChange={event => {
              const checked = event.target.checked
              setPreferences(previous => ({ ...previous, plugins: { ...previous.plugins, [plugin.id]: checked } }))
            }} />
          </li>
        })}
      </ul>
    </SettingsDialog>}
  </>
}
