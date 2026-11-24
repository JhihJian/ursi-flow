import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, LayoutTemplate, Monitor, Puzzle, RotateCcw, Smartphone, Workflow } from 'lucide-react'
import { PluginInventory } from './PluginInventory'
import { limits, parsePortalConfig, type PortalConfig, type PublishedConfig } from './portal-config'
import { pluginManifest } from './plugin-manifest'
import type { PluginStatus } from './plugin-runtime'

const origin = location.origin
const pluginIds = pluginManifest.map(plugin => plugin.id)
const statuses = new Set<PluginStatus>(['loading', 'ready', 'load-failed', 'load-timeout', 'activation-failed', 'render-failed'])
const currentTab = () => location.hash === '#plugins' ? 'plugins' : 'pages'

function validate(draft: PortalConfig) {
  try { return { config: parsePortalConfig(draft, pluginIds, origin), error: undefined } }
  catch (error) { return { config: undefined, error: (error as Error).message } }
}

function PageEditor({ page, change }: { page: PortalConfig['page']; change: <K extends keyof PortalConfig['page']>(key: K, value: PortalConfig['page'][K]) => void }) {
  return <>
    <section className="manage-section" aria-labelledby="page-content">
      <div className="section-head"><h2 id="page-content">首页内容</h2><code>/</code></div>
      <label className="field">品牌<input value={page.brand} maxLength={limits.brand} required onChange={event => change('brand', event.target.value)} /></label>
      <label className="field">项目名称<input value={page.name} maxLength={limits.name} required onChange={event => change('name', event.target.value)} /></label>
      <label className="field">项目简介<textarea value={page.description} maxLength={limits.description} rows={3} onChange={event => change('description', event.target.value)} /></label>
    </section>
    <section className="manage-section" aria-labelledby="page-layout">
      <div className="section-head"><h2 id="page-layout">链接与布局</h2></div>
      <label className="field">仓库地址<input value={page.repository} maxLength={limits.url} spellCheck={false} onChange={event => change('repository', event.target.value)} /></label>
      <label className="field">宽屏扩展区位置<select value={page.placement} onChange={event => change('placement', event.target.value === 'below' ? 'below' : 'right')}>
        <option value="right">主内容右侧</option><option value="below">主内容下方</option>
      </select></label>
    </section>
  </>
}

export function Manage({ published, projectId }: { published: PublishedConfig; projectId: string }) {
  const { config: baseline, source, problem } = published
  const draftKey = `ursi.portal.draft:${projectId}:${baseline.revision}`
  const [draft, setDraft] = useState<PortalConfig>(() => {
    try { return parsePortalConfig(JSON.parse(sessionStorage.getItem(draftKey) ?? 'null'), pluginIds, origin) }
    catch { return baseline }
  })
  const [tab, setTab] = useState(currentTab)
  const [mobile, setMobile] = useState(false)
  const [frameRun, setFrameRun] = useState(0)
  const [liveStatus, setLiveStatus] = useState<Partial<Record<string, PluginStatus>>>({})
  const [notice, setNotice] = useState('')
  const [storageFailed, setStorageFailed] = useState(false)
  const main = useRef<HTMLElement>(null)
  const iframe = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [stageWidth, setStageWidth] = useState(0)
  const previewWidth = mobile ? 360 : 1120
  const scale = Math.min(1, (stageWidth || previewWidth) / previewWidth)
  const valid = validate(draft)
  const { config: validated, error } = valid
  const serialized = validated ? JSON.stringify(validated) : undefined
  const changed = JSON.stringify(draft) !== JSON.stringify(baseline)
  const title = tab === 'plugins' ? '插件管理' : '页面管理'

  useEffect(() => {
    const switchTab = () => { setTab(currentTab()); setNotice('') }
    window.addEventListener('hashchange', switchTab)
    return () => window.removeEventListener('hashchange', switchTab)
  }, [])
  useEffect(() => { document.title = `${title} · ${baseline.page.brand}` }, [title, baseline.page.brand])
  useEffect(() => {
    const target = stage.current
    if (!target) return
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width))
    observer.observe(target)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    try {
      if (!changed) sessionStorage.removeItem(draftKey)
      else if (serialized) sessionStorage.setItem(draftKey, serialized)
      setStorageFailed(false)
    } catch { setStorageFailed(changed) }
  }, [changed, draftKey, serialized])
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== origin || !iframe.current || event.source !== iframe.current.contentWindow) return
      if (event.data?.type === 'portal-preview:ready') {
        if (serialized) iframe.current.contentWindow?.postMessage({ type: 'portal-preview:config', config: JSON.parse(serialized) }, origin)
      } else if (event.data?.type === 'portal-preview:status') {
        const { id, status } = event.data
        if (pluginIds.includes(id) && statuses.has(status)) setLiveStatus(previous => ({ ...previous, [id]: status }))
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [serialized])
  useEffect(() => {
    if (serialized) iframe.current?.contentWindow?.postMessage({ type: 'portal-preview:config', config: JSON.parse(serialized) }, origin)
  }, [serialized])

  function edit(update: (value: PortalConfig) => PortalConfig) {
    setNotice('')
    setDraft(update)
  }

  function exportConfig() {
    if (!validated) return
    const revision = `release-${new Date().toISOString().replace(/[^0-9]/g, '')}`
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...validated, revision }, null, 2) + '\n'], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'portal-config.json'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice(`已导出 ${revision}，尚未发布`)
  }

  return <div className="manage-shell">
    <a className="manage-skip" href="#manage-main" onClick={event => {
      event.preventDefault()
      main.current?.focus()
    }}>跳到主要内容</a>
    <header className="manage-header">
      <a href="/" className="brand"><span className="mark"><Workflow size={18} aria-hidden="true" /></span>{baseline.page.brand}</a>
      <nav aria-label="管理导航" className="manage-nav">
        <a href="#pages" aria-current={tab === 'pages' ? 'page' : undefined}><LayoutTemplate size={17} aria-hidden="true" />页面管理</a>
        <a href="#plugins" aria-current={tab === 'plugins' ? 'page' : undefined}><Puzzle size={17} aria-hidden="true" />插件管理</a>
      </nav>
      <a className="tool back-link" href="/"><ArrowLeft size={16} aria-hidden="true" />返回首页</a>
    </header>
    <main ref={main} id="manage-main" tabIndex={-1} className="manage-main">
      <div className="manage-heading">
        <div><h1>{title}</h1><div className="revision-line"><span>{source === 'published' ? '当前发布' : source === 'development' ? '开发默认' : '基础首页'}</span><code>{baseline.revision}</code><span>{changed ? '未发布的草稿' : '无变更'}</span></div></div>
        <div className="manage-actions">
          <button type="button" className="tool secondary" disabled={!changed} onClick={() => { setDraft(baseline); setNotice('已还原到当前配置') }}><RotateCcw size={15} aria-hidden="true" />还原草稿</button>
          <button type="button" className="tool primary" disabled={!validated} onClick={exportConfig}><Download size={16} aria-hidden="true" />导出配置</button>
        </div>
      </div>
      {problem && <p className="config-warning" role="alert">{problem}</p>}
      {error && <p className="config-warning" role="alert">{error}，预览停留在上一个有效草稿。</p>}
      {storageFailed && <p className="config-warning" role="alert">浏览器无法保存草稿，刷新前请导出。</p>}
      <span className="manage-notice" role="status">{notice}</span>
      <div className="manage-grid">
        <div className="manage-editor">
          {tab === 'pages'
            ? <PageEditor page={draft.page} change={(key, value) => edit(previous => ({ ...previous, page: { ...previous.page, [key]: value } }))} />
            : <PluginInventory draft={draft} statuses={liveStatus}
                toggle={(id, enabled) => {
                  setLiveStatus(previous => ({ ...previous, [id]: undefined }))
                  edit(previous => ({ ...previous, plugins: { ...previous.plugins, [id]: enabled } }))
                }}
                changeUrl={workbenchUrl => edit(previous => ({ ...previous, workbenchUrl }))} />}
        </div>
        <section className="manage-preview" aria-labelledby="preview-heading">
          <div className="section-head"><h2 id="preview-heading">首页预览</h2>
            <div className="preview-tools">
              <button type="button" className="tool secondary" aria-pressed={!mobile} aria-label="宽屏预览" title="宽屏预览" onClick={() => setMobile(false)}><Monitor size={17} aria-hidden="true" /></button>
              <button type="button" className="tool secondary" aria-pressed={mobile} aria-label="窄屏预览" title="窄屏预览" onClick={() => setMobile(true)}><Smartphone size={17} aria-hidden="true" /></button>
              <button type="button" className="tool secondary" aria-label="重新检测预览" title="重新检测预览" disabled={!validated} onClick={() => { setLiveStatus({}); setFrameRun(run => run + 1) }}><RotateCcw size={16} aria-hidden="true" /></button>
            </div>
          </div>
          <div className="preview-stage" ref={stage}>
            <iframe key={frameRun} ref={iframe} title="首页草稿预览" src="/?portal-preview=1" style={{ width: previewWidth, height: mobile ? 680 : 720, zoom: scale }}
              onLoad={() => { if (validated) iframe.current?.contentWindow?.postMessage({ type: 'portal-preview:config', config: validated }, origin) }} />
          </div>
        </section>
      </div>
    </main>
  </div>
}
