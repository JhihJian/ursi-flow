import { createRoot } from 'react-dom/client'
import App from './App'
// 侧栏行样式要在模块样式之前加载，模块刻意的底色才能盖过它的 hover。
import '@ursi/sidebar/style.css'
// 选目录器的样式：DirBrowser 自己也会引，这里按 pi-web 独立入口的写法显式引一次。
import '@ursi/directory-picker/style.css'
import './styles.css'
import './standalone.css'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')
createRoot(container).render(<App apiBaseUrl="/api" />)
