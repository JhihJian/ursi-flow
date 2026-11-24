import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider } from 'react-router'
import { createMcpClient, createMcpRoutes } from '../src'
import { mockRequest } from './mock'
import './preview.css'

const nav = [
  { to: '/mcp-servers', label: '服务登记' },
  { to: '/mcp-servers/github', label: '服务详情' },
  { to: '/mcp-recognition-rules', label: '识别规则' },
]

function Shell() {
  return (
    <div className="preview-shell">
      <header className="preview-top">
        <div className="preview-top-inner">
          <Link to="/mcp-servers" className="preview-brand">mcp-web · 样式预览</Link>
          <nav className="preview-nav">
            {nav.map(item => <Link key={item.to} to={item.to}>{item.label}</Link>)}
          </nav>
        </div>
      </header>
      <main className="preview-main"><Outlet /></main>
    </div>
  )
}

const router = createBrowserRouter([{
  element: <Shell />,
  children: [
    { index: true, element: <Navigate to="/mcp-servers" replace /> },
    ...createMcpRoutes({ client: createMcpClient(mockRequest) }),
  ],
}])

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 挂载点。')
createRoot(root).render(<RouterProvider router={router} />)
