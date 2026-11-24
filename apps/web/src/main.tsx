import { createRoot } from 'react-dom/client'
import { Portal } from './Portal'
import { pluginManifest } from './plugin-manifest'
import { readProject } from './project'
import './styles.css'

const context = readProject(import.meta.env, window.location)
document.title = context.project.name === context.project.brand
  ? context.project.name
  : `${context.project.name} · ${context.project.brand}`
const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')
createRoot(container).render(<Portal key={context.project.id} context={context} manifest={pluginManifest} />)
