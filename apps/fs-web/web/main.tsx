import { createRoot } from 'react-dom/client'
import { FsWebStandalone } from './src/standalone.tsx'
import '@ursi/directory-picker/style.css'
import './src/standalone.css'
import './src/module.css'

/** fs-web 独立预览入口：vite 以本目录为 root，多页输入指向这里。 */

const Standalone = FsWebStandalone()
const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')
createRoot(container).render(<Standalone />)
