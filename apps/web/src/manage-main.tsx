import { createRoot } from 'react-dom/client'
import { Manage } from './Manage'
import { pluginManifest } from './plugin-manifest'
import { loadPublishedConfig } from './portal-config'
import { readProject } from './project'
import './styles.css'
import './manage.css'

const context = readProject(import.meta.env, window.location)
const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')
const root = createRoot(container)
root.render(<p className="loading-page" role="status">正在读取站点配置…</p>)
void loadPublishedConfig(context, pluginManifest, import.meta.env.DEV).then(published => {
  root.render(<Manage published={published} projectId={context.project.id} />)
})
