import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createMcpClient, createMcpRoutes, type McpRequest, type McpServer } from '../src'

afterEach(cleanup)
const server = { id: 'team 1', name: '材料服务', url: 'https://fixture.example/mcp' }
const resource = { name: '周报', uri: 'memo:weekly' }
function mount(path: string, send: (path: string, init: RequestInit) => unknown) {
  const request: McpRequest = async <T,>(path: string, init: RequestInit) => send(path, init) as T
  const client = createMcpClient(request)
  const listVariableNames = vi.fn(async () => ['TEAM_TOKEN'])
  const routes = createMcpRoutes({ client, listVariableNames, variableManagementPath: '/admin/credentials' })
  const router = createMemoryRouter([{ path: 'admin', children: routes }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return { listVariableNames, router, user: userEvent.setup() }
}

it('嵌套路由使用注入的变量名登记服务，通知和资源浏览不需要宿主组件', async () => {
  const registry: McpServer[] = []
  const { user, listVariableNames } = mount('/admin/mcp-servers', (path, options) => {
    if (path.endsWith('/inspection')) return { resources: [resource] }
    expect(path).toBe('/mcp-servers')
    if (!options.method) return [...registry]
    expect(options.method).toBe('POST')
    expect(JSON.parse(String(options.body))).toEqual({ name: server.name, url: server.url, credentialEnv: 'TEAM_TOKEN', binding: 'platform' })
    registry.push({ ...server, credentialEnv: 'TEAM_TOKEN' })
    return registry[0]
  })
  await screen.findByText('暂无服务登记')
  expect(listVariableNames).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '登记服务' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByRole('link', { name: '管理平台变量' })).toHaveAttribute('href', '/admin/credentials')
  await user.type(dialog.getByLabelText('服务名称'), server.name)
  await user.type(dialog.getByLabelText('服务地址'), server.url)
  await user.selectOptions(dialog.getByLabelText(/平台凭据/), 'TEAM_TOKEN')
  expect(dialog.getByText(/Bearer/)).toHaveTextContent(server.url)
  await user.click(dialog.getByRole('button', { name: '添加服务' }))
  expect(await screen.findByText(`「${server.name}」已登记`)).toBeVisible()
  const browse = await screen.findByRole('link', { name: '浏览资源' })
  expect(browse).toHaveAttribute('href', '/admin/mcp-servers/team%201')
  await user.click(browse)
  expect(await screen.findByRole('button', { name: '周报' })).toBeVisible()
  expect(screen.getByRole('link', { name: '返回服务列表' })).toHaveAttribute('href', '/admin/mcp-servers')
})

it('从深链读取正文，工具须先授权，取消确认不调用，确认只调用一次', async () => {
  const calls = vi.fn(() => ({ content: [{ text: '调用成功' }] }))
  const { user } = mount('/admin/mcp-servers/team%201?uri=memo%3Aweekly', (path, options) => {
    if (path === '/mcp-servers') return [server]
    if (path.endsWith('/inspection')) return { resources: [resource] }
    if (path.endsWith('/resources/read')) return { contents: [{ uri: resource.uri, text: '本周材料' }] }
    if (path.endsWith('/catalog/tools')) return [{ name: 'echo' }]
    if (path.endsWith('/settings')) return JSON.parse(String(options.body))
    if (path.endsWith('/tools/call')) return calls()
    throw new Error(path)
  })
  expect(await screen.findByText('本周材料')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '工具目录' }))
  await user.click(await screen.findByRole('button', { name: 'echo' }))
  const invoke = screen.getByRole('button', { name: '调用工具' })
  expect(invoke).toBeDisabled()
  await user.click(screen.getByRole('switch', { name: '允许调用 echo' }))
  await user.click(invoke)
  expect(screen.getByRole('dialog')).toHaveTextContent(server.url)
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(calls).not.toHaveBeenCalled()
  await user.click(invoke)
  await user.click(screen.getByRole('button', { name: '确认调用' }))
  expect(await screen.findByText(/调用成功/)).toBeVisible()
  expect(calls).toHaveBeenCalledTimes(1)
})
