import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, Outlet, useLocation } from 'react-router'

import { setToken } from '@/shared/http/session'
import { mcpRoutes } from './routes'

const servers = [{ id: 's1', name: '反馈服务', url: 'http://127.0.0.1:1/mcp' }]
const resources = [
  { name: '周报', uri: 'memo:a' },
  { name: '架构图', uri: 'memo:b', mimeType: 'image/png' },
]

const peer = { name: 'fixture', version: '1', protocolVersion: '2025-06-18', capabilities: { resources: true, tools: false, prompts: false } }

function stubApi(read: () => Response, inspect = () => Response.json({ server: peer, resources })) {
  const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async input => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/v2/mcp-servers') return Response.json(servers)
    if (url.pathname === '/api/v2/mcp-servers/s1/inspection') return inspect()
    if (url.pathname === '/api/v2/mcp-servers/s1/resources/read') return read()
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

function mount(path: string) {
  const router = createMemoryRouter(
    [{ element: <><Outlet /><LocationProbe /></>, children: mcpRoutes }],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
}

beforeEach(() => setToken('browse-test'))
afterEach(() => { setToken(''); cleanup(); vi.unstubAllGlobals() })

describe('资源浏览', () => {
  it('地址中的 URI 直接读取并展示正文', async () => {
    const fetch = stubApi(() => Response.json({ contents: [{ uri: 'memo:a', text: '来自服务' }] }))
    mount('/mcp-servers/s1?uri=memo%3Aa')

    expect(await screen.findByText('来自服务')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '周报' })).toBeInTheDocument()
    expect(screen.getByText('共 2 个资源')).toBeInTheDocument()
    expect(screen.getByText('2025-06-18')).toBeInTheDocument()
    expect(screen.getByText('已登记')).toBeInTheDocument()
    const read = fetch.mock.calls.find(([input]) => String(input).endsWith('/resources/read'))
    expect(read).toBeDefined()
    expect(read![1]?.method).toBe('POST')
    expect(JSON.parse(String(read![1]?.body))).toEqual({ uri: 'memo:a' })
  })

  it('搜索过滤列表，点击结果把选择写回地址', async () => {
    const fetch = stubApi(() => Response.json({ contents: [{ uri: 'memo:b', blob: 'AP8A' }] }))
    mount('/mcp-servers/s1')
    await screen.findByRole('button', { name: /周报/ })

    await userEvent.type(screen.getByLabelText('搜索资源'), '架构')
    expect(screen.getByText('共 2 个资源，匹配 1 个')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /周报/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /架构图/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/mcp-servers/s1?uri=memo%3Ab')
    expect(await screen.findByText(/共 3 字节/)).toBeInTheDocument()
    expect(screen.getByText(/不在页面预览/)).toBeInTheDocument()
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith('/resources/read'))).toHaveLength(1)
  })

  it('未声明资源时不读取 URI，也不报连接错误', async () => {
    const fetch = stubApi(() => Response.error(), () => Response.json({
      server: { ...peer, capabilities: { resources: false, tools: true, prompts: false } }, resources: [],
    }))
    mount('/mcp-servers/s1?uri=memo%3Aa')

    expect(await screen.findByText('服务未声明资源能力')).toBeInTheDocument()
    expect(screen.getByText('工具')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/resources/read'))).toBe(false)
  })

  it('读取失败显示原因并允许重试', async () => {
    let attempts = 0
    stubApi(() => {
      attempts += 1
      return attempts === 1
        ? Response.json({ error: 'MCP 服务连接失败或协议响应无效' }, { status: 503 })
        : Response.json({ contents: [{ uri: 'memo:a', text: '第二次成功' }] })
    })
    mount('/mcp-servers/s1?uri=memo%3Aa')

    expect(await screen.findByRole('alert')).toHaveTextContent('MCP 服务连接失败或协议响应无效')
    await userEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(await screen.findByText('第二次成功')).toBeInTheDocument()
  })
})
