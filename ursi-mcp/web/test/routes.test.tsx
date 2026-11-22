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
  await user.selectOptions(dialog.getByLabelText('凭据方式'), 'env')
  expect(dialog.getByRole('link', { name: '管理平台变量' })).toHaveAttribute('href', '/admin/credentials')
  await user.type(dialog.getByLabelText('服务名称'), server.name)
  await user.type(dialog.getByLabelText('服务地址'), server.url)
  await user.selectOptions(dialog.getByLabelText(/凭据引用/), 'TEAM_TOKEN')
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
    .mockImplementationOnce(() => ({ status: 'checked', checkedAt, labels: ['执行器 v1'] }))
    .mockImplementationOnce(() => { throw new Error('暂时无法连接') })
    .mockImplementationOnce(() => ({ status: 'checked', checkedAt, labels: [] }))
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
  expect(await screen.findByText('执行器 v1')).toHaveAttribute('title', '上次协议检查时匹配的标签')
  await user.click(screen.getByRole('button', { name: '刷新登记' }))
  expect(probe).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('link', { name: '浏览资源' }))
  expect(await screen.findByText('匹配 1 个标签')).toBeVisible()
  expect(document.querySelector('time')).toHaveAttribute('datetime', new Date(checkedAt).toISOString())
  const recheck = screen.getByRole('button', { name: '重新检查协议' })
  await user.click(recheck)
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法连接')
  expect(screen.getByText('执行器 v1')).toBeVisible()
  await user.click(recheck)
  expect(await screen.findByText('未匹配识别规则')).toBeVisible()
  await user.click(screen.getByRole('link', { name: '返回服务列表' }))
  await screen.findByRole('button', { name: '检查协议' })
  expect(screen.queryByText('执行器 v1')).not.toBeInTheDocument()
})

it('识别规则可编辑保存并按新规则重新检查', async () => {
  let saved: unknown[] | null = null
  const server2 = { ...server, protocolCheck: { status: 'checked', checkedAt: 1, labels: ['执行器 v1'] } }
  const { user } = mount('/admin/mcp-servers', (path, { method, body }) => {
    if (path === '/mcp-recognition-rules') {
      if (method === 'PUT') {
        saved = JSON.parse(String(body))
        return saved
      }
      return saved ?? [{ id: 'executor-v1', label: '执行器 v1', metaKey: 'ursi/executorProtocol', equals: '1' }]
    }
    if (path === '/mcp-servers') return [saved ? server : server2]
    throw new Error(path)
  })
  await screen.findByText('执行器 v1')
  await user.click(screen.getByRole('link', { name: '识别规则' }))
  await screen.findByDisplayValue('ursi/executorProtocol')
  await user.type(screen.getByLabelText('标签名称'), '（已授权）')
  await user.click(screen.getByRole('button', { name: '添加规则' }))
  await user.type(screen.getAllByLabelText('规则 ID')[1], 'analysis')
  await user.type(screen.getAllByLabelText('标签名称')[1], '分析')
  await user.type(screen.getAllByLabelText('元数据键')[1], 'ursi/serviceKind')
  await user.type(screen.getAllByLabelText('等于值')[1], 'analysis')
  await user.click(screen.getByRole('button', { name: '保存全部规则' }))
  await user.click(await screen.findByRole('button', { name: '保存规则' }))
  expect(await screen.findByText(/已保存 2 条识别规则/)).toBeVisible()
  expect(saved).toEqual([
    { id: 'executor-v1', label: '执行器 v1（已授权）', metaKey: 'ursi/executorProtocol', equals: '1' },
    { id: 'analysis', label: '分析', metaKey: 'ursi/serviceKind', equals: 'analysis' },
  ])
  expect(screen.queryByText('执行器 v1')).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: '返回服务列表' })).toHaveAttribute('href', '/admin/mcp-servers')
})

it('拒绝重复规则并在放弃修改后还原列表', async () => {
  const seed = [{ id: 'executor-v1', label: '执行器 v1', metaKey: 'ursi/executorProtocol', equals: '1' }]
  const put = vi.fn()
  const { user } = mount('/admin/mcp-recognition-rules', (path, { method }) => {
    if (path === '/mcp-recognition-rules' && method === 'PUT') { put(); return seed }
    if (path === '/mcp-recognition-rules') return seed
    throw new Error(path)
  })
  await screen.findByDisplayValue('ursi/executorProtocol')
  await user.click(screen.getByRole('button', { name: '添加规则' }))
  await user.type(screen.getAllByLabelText('规则 ID')[1], 'executor-v1')
  await user.type(screen.getAllByLabelText('标签名称')[1], '重复 ID')
  await user.type(screen.getAllByLabelText('元数据键')[1], 'ursi/executorProtocol')
  await user.type(screen.getAllByLabelText('等于值')[1], '1')
  expect(await screen.findByText(/规则 ID「executor-v1」重复/)).toBeVisible()
  expect(screen.getByRole('button', { name: '保存全部规则' })).toBeDisabled()
  expect(put).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '放弃修改' }))
  expect(screen.getByDisplayValue('ursi/executorProtocol')).toBeVisible()
  expect(screen.getAllByLabelText('规则 ID')).toHaveLength(1)
  await user.type(screen.getByLabelText('标签名称'), '新名')
  await user.click(screen.getByRole('button', { name: '保存全部规则' }))
  await user.click(await screen.findByRole('button', { name: '保存规则' }))
  expect(put).toHaveBeenCalledTimes(1)
})

it('独立宿主可输入凭据引用或直接填写密钥，不列举或管理部署凭据', async () => {
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
  const modeSelect = dialog.getByLabelText('凭据方式')
  expect(within(modeSelect).queryByRole('option', { name: '平台凭据引用' })).not.toBeInTheDocument()
  await user.type(dialog.getByLabelText('服务名称'), server.name)
  await user.type(dialog.getByLabelText('服务地址'), server.url)
  await user.selectOptions(modeSelect, 'env')
  await user.type(dialog.getByLabelText('凭据引用'), 'TEAM_TOKEN')
  await user.click(dialog.getByRole('button', { name: '添加服务' }))
  expect(create).toHaveBeenCalledWith({ name: server.name, url: server.url, credentialEnv: 'TEAM_TOKEN', binding: 'platform' })
  expect(listVariableNames).not.toHaveBeenCalled()
  await user.click(await screen.findByRole('button', { name: '登记服务' }))
  const second = within(screen.getByRole('dialog'))
  await user.type(second.getByLabelText('服务名称'), server.name)
  await user.type(second.getByLabelText('服务地址'), server.url)
  await user.selectOptions(second.getByLabelText('凭据方式'), 'secret')
  await user.type(second.getByLabelText('访问密钥'), 'shh-secret')
  expect(second.getByText(/Bearer/)).toHaveTextContent(server.url)
  await user.click(second.getByRole('button', { name: '添加服务' }))
  expect(create).toHaveBeenLastCalledWith({ name: server.name, url: server.url, credentialSecret: 'shh-secret', binding: 'platform' })
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
