/**
 * 独立部署入口：占满视口的单页控制台（HashRouter）。
 * 嵌入工作台外壳时走 src/module.tsx（MemoryRouter + 模块工厂）。
 */
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import { AppRoot } from './AppRoot'
import { SandboxConsole } from './App'
import './standalone.css'

createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <AppRoot>
      <SandboxConsole />
    </AppRoot>
  </HashRouter>,
)
