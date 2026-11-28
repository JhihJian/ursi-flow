import { createRoot } from 'react-dom/client'
import App from './App'
import { DemandProvider } from '@demand/react'
// 侧栏行样式要在模块样式之前加载，模块刻意的底色才能盖过它的 hover。
import '@ursi/sidebar/style.css'
// 选目录器的样式进 .dp 容器作用域；独立页面自己引一次，嵌入外壳时由组合根引。
import '@ursi/directory-picker/style.css'
import './styles.css'
import './standalone.css'

// 用户需求随构建打进包：?raw 让 Vite 把 DEMAND.md 当字符串，改文件 HMR 立即刷新。
// 遮罩只在开发服务器上开；部署后的实例要能开的话，enabled 改读 URL 参数。
import demandSource from '../../DEMAND.md?raw'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')

const demandEnabled = import.meta.env.DEV

createRoot(container).render(
  <DemandProvider source={demandSource} enabled={demandEnabled}>
    <App />
  </DemandProvider>,
)
