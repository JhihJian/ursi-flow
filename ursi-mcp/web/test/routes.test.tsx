import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createMcpClient, createMcpRoutes, type McpRequest, type McpServer } from '../src'

afterEach(cleanup)
const server = { id: 'team 1', name: '材料服务', url: 'https://fixture.example/mcp' }
const resource = { name: '周报', uri: 'memo:weekly' }
function mount(path: string, send: (path: string, init: RequestInit) => unknown, managed = true) {
  const request: McpRequest = async <T,>(path: string, init: RequestInit) => send(path, init) as T
  const client = createMcpClient(request)
  const listVariableNames = vi.fn(async () => ['TEAM_TOKEN'])
  const routes = createMcpRoutes({ client, ...(managed && { listVariableNames, variableManagementPath: '/admin/credentials' }) })
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

it('只在显式协议检查后更新列表标签，复查失败保留标签，撤回声明时移除', async () => {
  let row: McpServer = server
  const checkedAt = Date.UTC(2026, 6, 28)
  const probe = vi.fn()
    .mockImplementationOnce(() => ({ status: 'declaredV1', checkedAt }))
    .mockImplementationOnce(() => { throw new Error('暂时无法连接') })
    .mockImplementationOnce(() => ({ status: 'notDeclared', checkedAt }))
  const { user } = mount('/admin/mcp-servers', (path, { method, body }) => {
    if (path === '/mcp-servers') return [row]
    if (path.endsWith('/inspection')) return { resources: [resource] }
    expect(path).toBe('/mcp-servers/team%201/protocol-check')
    expect(method).toBe('POST')
    expect(body).toBeUndefined()
    const protocolCheck = probe()
    row = { ...row, protocolCheck }
    return protocolCheck
  })
  const button = await screen.findByRole('button', { name: '检查协议' })
  expect(probe).not.toHaveBeenCalled()
  expect(screen.queryByText('执行器 v1')).not.toBeInTheDocument()
  await user.click(button)
  expect(await screen.findByText('执行器 v1')).toHaveAttribute('title', '上次检查时服务自报支持执行器 v1')
  await user.click(screen.getByRole('button', { name: '刷新登记' }))
  expect(probe).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('link', { name: '浏览资源' }))
  expect(await screen.findByText('服务自报支持执行器 v1')).toBeVisible()
  expect(document.querySelector('time')).toHaveAttribute('datetime', new Date(checkedAt).toISOString())
  const recheck = screen.getByRole('button', { name: '重新检查协议' })
  await user.click(recheck)
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法连接')
  expect(screen.getByText('执行器 v1')).toBeVisible()
  await user.click(recheck)
  expect(await screen.findByText('未声明执行器协议')).toBeVisible()
  await user.click(screen.getByRole('link', { name: '返回服务列表' }))
  await screen.findByRole('button', { name: '检查协议' })
  expect(screen.queryByText('执行器 v1')).not.toBeInTheDocument()
})

it('独立宿主只输入凭据引用，不列举或管理部署凭据', async () => {
  const create = vi.fn()
  const { user, listVariableNames } = mount('/admin/mcp-servers', (path, options) => {
    expect(path).toBe('/mcp-servers')
    if (options.method !== 'POST') return []
    create(JSON.parse(String(options.body)))
    return server
  }, false)
  await user.click(await screen.findByRole('button', { name: '登记服务' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.queryByRole('link', { name: '管理平台变量' })).not.toBeInTheDocument()
  await user.type(dialog.getByLabelText('服务名称'), server.name)
  await user.type(dialog.getByLabelText('服务地址'), server.url)
  await user.type(dialog.getByLabelText(/凭据引用/), 'TEAM_TOKEN')
  await user.click(dialog.getByRole('button', { name: '添加服务' }))
  expect(create).toHaveBeenCalledWith({ name: server.name, url: server.url, credentialEnv: 'TEAM_TOKEN', binding: 'platform' })
  expect(listVariableNames).not.toHaveBeenCalled()
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
