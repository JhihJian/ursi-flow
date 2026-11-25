/**
 * 独立部署入口：HashRouter + 共享数据层 + 侧边栏/工作区两栏布局。
 * 嵌入工作台外壳时走 src/module.tsx（MemoryRouter + 外壳骨架）。
 */
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import { SandboxDataProvider } from './common'
import { SandboxStandalone } from './standalone'
import './standalone.css'

createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <SandboxDataProvider>
      <SandboxStandalone />
    </SandboxDataProvider>
  </HashRouter>,
)
