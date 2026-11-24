import { createRoot } from 'react-dom/client'
import { Portal } from './Portal'
import { Preview } from './Preview'
import { pluginManifest } from './plugin-manifest'
import { applyPortalConfig, loadPublishedConfig } from './portal-config'
import { readProject } from './project'
import './styles.css'

const context = readProject(import.meta.env, window.location)
const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')
const root = createRoot(container)

if (window.parent !== window && new URLSearchParams(location.search).get('portal-preview') === '1') {
  root.render(<Preview context={context} />)
} else {
  root.render(<p className="loading-page" role="status">正在读取站点配置…</p>)
  void loadPublishedConfig(context, pluginManifest, import.meta.env.DEV).then(({ config, problem }) => {
    document.title = config.page.name === config.page.brand ? config.page.name : `${config.page.name} · ${config.page.brand}`
    root.render(<Portal context={applyPortalConfig(config, context, location.origin)} manifest={pluginManifest} config={config} problem={problem} />)
  })
}
