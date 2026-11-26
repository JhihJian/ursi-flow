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
    .mockImplementationOnce(() => ({ status: 'checked', checkedAt, labels: ['团队服务'] }))
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
  expect(screen.queryByText('团队服务')).not.toBeInTheDocument()
  await user.click(button)
  expect(await screen.findByText('团队服务')).toHaveAttribute('title', '上次协议检查时匹配的标签')
  await user.click(screen.getByRole('button', { name: '刷新登记' }))
  expect(probe).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('link', { name: '浏览资源' }))
  expect(await screen.findByText('匹配 1 个标签')).toBeVisible()
  expect(document.querySelector('time')).toHaveAttribute('datetime', new Date(checkedAt).toISOString())
  const recheck = screen.getByRole('button', { name: '重新检查协议' })
  await user.click(recheck)
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法连接')
  expect(screen.getByText('团队服务')).toBeVisible()
  await user.click(recheck)
  expect(await screen.findByText('未匹配识别规则')).toBeVisible()
  await user.click(screen.getByRole('link', { name: '返回服务列表' }))
  await screen.findByRole('button', { name: '检查协议' })
  expect(screen.queryByText('团队服务')).not.toBeInTheDocument()
})

it('识别规则可编辑保存并按新规则重新检查', async () => {
  let saved: unknown[] | null = null
  const server2 = { ...server, protocolCheck: { status: 'checked', checkedAt: 1, labels: ['团队服务'] } }
  const { user } = mount('/admin/mcp-servers', (path, { method, body }) => {
    if (path === '/mcp-recognition-rules') {
      if (method === 'PUT') {
        saved = JSON.parse(String(body))
        return saved
      }
      return saved ?? [{ id: 'team-v1', label: '团队服务', metaKey: 'example/serviceKind', equals: '1' }]
    }
    if (path === '/mcp-servers') return [saved ? server : server2]
    throw new Error(path)
  })
  await screen.findByText('团队服务')
  await user.click(screen.getByRole('link', { name: '识别规则' }))
  await screen.findByDisplayValue('example/serviceKind')
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
    { id: 'team-v1', label: '团队服务（已授权）', metaKey: 'example/serviceKind', equals: '1' },
    { id: 'analysis', label: '分析', metaKey: 'ursi/serviceKind', equals: 'analysis' },
  ])
  expect(screen.queryByText('团队服务')).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: '返回服务列表' })).toHaveAttribute('href', '/admin/mcp-servers')
})

it('拒绝重复规则并在放弃修改后还原列表', async () => {
  const seed = [{ id: 'team-v1', label: '团队服务', metaKey: 'example/serviceKind', equals: '1' }]
  const put = vi.fn()
  const { user } = mount('/admin/mcp-recognition-rules', (path, { method }) => {
    if (path === '/mcp-recognition-rules' && method === 'PUT') { put(); return seed }
    if (path === '/mcp-recognition-rules') return seed
    throw new Error(path)
  })
  await screen.findByDisplayValue('example/serviceKind')
  await user.click(screen.getByRole('button', { name: '添加规则' }))
  await user.type(screen.getAllByLabelText('规则 ID')[1], 'team-v1')
  await user.type(screen.getAllByLabelText('标签名称')[1], '重复 ID')
  await user.type(screen.getAllByLabelText('元数据键')[1], 'example/serviceKind')
  await user.type(screen.getAllByLabelText('等于值')[1], '1')
  expect(await screen.findByText(/规则 ID「team-v1」重复/)).toBeVisible()
  expect(screen.getByRole('button', { name: '保存全部规则' })).toBeDisabled()
  expect(put).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '放弃修改' }))
  expect(screen.getByDisplayValue('example/serviceKind')).toBeVisible()
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
  await user.click(screen.getByRole('tab', { name: '工具目录' }))
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

it('带 inputSchema 的工具默认表单填写，必填校验后确认提交', async () => {
  const calls = vi.fn(() => ({ content: [{ text: '列出成功' }] }))
  let invokeBody: unknown
  const tool = {
    name: 'list_issues',
    description: '列出 issues',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: '仓库归属' },
        state: { type: 'string', enum: ['open', 'closed'], description: '状态' },
        perPage: { type: 'number', description: '每页数量' },
        includeBody: { type: 'boolean', description: '含正文' },
      },
      required: ['owner'],
    },
  }
  const { user } = mount('/admin/mcp-servers/team%201', (path, options) => {
    if (path === '/mcp-servers') return [server]
    if (path.endsWith('/inspection')) return { resources: [resource] }
    if (path.endsWith('/catalog/tools')) return [tool]
    if (path.endsWith('/settings')) return JSON.parse(String(options.body))
    expect(path.endsWith('/tools/call')).toBe(true)
    invokeBody = JSON.parse(String(options.body))
    return calls()
  })
  await user.click(await screen.findByRole('tab', { name: '工具目录' }))
  await user.click(await screen.findByRole('button', { name: 'list_issues' }))
  expect(screen.getByRole('tab', { name: '表单填写' })).toHaveAttribute('aria-selected', 'true')
  // 未填必填项时点击调用：确认弹窗展示，但参数校验先拦截
  await user.click(screen.getByRole('switch', { name: '允许调用 list_issues' }))
  await user.click(screen.getByRole('button', { name: '调用工具' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('alert')).toHaveTextContent('缺少必填参数：owner')
  expect(calls).not.toHaveBeenCalled()
  // 填写后成功提交
  await user.type(screen.getByLabelText('参数 owner'), 'octocat')
  await user.selectOptions(screen.getByLabelText('参数 state'), 'open')
  await user.type(screen.getByLabelText('参数 perPage'), '20')
  await user.click(screen.getByRole('switch', { name: '参数 includeBody' }))
  await user.click(screen.getByRole('button', { name: '调用工具' }))
  await user.click(screen.getByRole('button', { name: '确认调用' }))
  expect(await screen.findByText(/列出成功/)).toBeVisible()
  expect(calls).toHaveBeenCalledTimes(1)
  expect(invokeBody).toEqual({ name: 'list_issues', arguments: { includeBody: true, owner: 'octocat', perPage: 20, state: 'open' } })
})

it('表单与 JSON 模式双向切换保留已填参数', async () => {
  const calls = vi.fn(() => ({ content: [{ text: 'ok' }] }))
  const tool = {
    name: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, count: { type: 'number' } }, required: ['text'] },
  }
  const { user } = mount('/admin/mcp-servers/team%201', (path, options) => {
    if (path === '/mcp-servers') return [server]
    if (path.endsWith('/inspection')) return { resources: [resource] }
    if (path.endsWith('/catalog/tools')) return [tool]
    if (path.endsWith('/settings')) return JSON.parse(String(options.body))
    return calls()
  })
  await user.click(await screen.findByRole('tab', { name: '工具目录' }))
  await user.click(await screen.findByRole('button', { name: 'echo' }))
  await user.type(screen.getByLabelText('参数 text'), '你好')
  await user.type(screen.getByLabelText('参数 count'), '3')
  // 切到 JSON：已填内容转为 JSON 文本
  await user.click(screen.getByRole('tab', { name: 'JSON 模式' }))
  const textarea = screen.getByLabelText('调用参数（JSON 对象）') as HTMLTextAreaElement
  expect(JSON.parse(textarea.value)).toEqual({ text: '你好', count: 3 })
  // JSON 里再改，切回表单后保留
  await user.clear(textarea)
  await user.type(textarea, '{{"text":"改过","count":7}')
  await user.click(screen.getByRole('tab', { name: '表单填写' }))
  expect(screen.getByLabelText('参数 text')).toHaveDisplayValue('改过')
  expect(screen.getByLabelText('参数 count')).toHaveDisplayValue('7')
})

it('表单标记必填参数：红色星号、图例与 aria-required', async () => {
  const tool = {
    name: 'issue_read',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['get', 'get_field_values'], description: '读取方式' },
        owner: { type: 'string' },
        issue_number: { type: 'number' },
        paginate: { type: 'boolean' },
      },
      required: ['method', 'owner', 'issue_number'],
    },
  }
  const { user } = mount('/admin/mcp-servers/team%201', (path) => {
    if (path === '/mcp-servers') return [server]
    if (path.endsWith('/inspection')) return { resources: [resource] }
    if (path.endsWith('/catalog/tools')) return [tool]
    throw new Error(path)
  })
  await user.click(await screen.findByRole('tab', { name: '工具目录' }))
  await user.click(await screen.findByRole('button', { name: 'issue_read' }))
  expect(screen.getByText(/必填参数（3 个）/)).toBeVisible()
  for (const name of ['method', 'owner', 'issue_number'])
    expect(screen.getByLabelText(`参数 ${name}`)).toHaveAttribute('aria-required', 'true')
  expect(screen.getByLabelText('参数 paginate')).not.toHaveAttribute('aria-required')
})

it('工具结果按 structuredContent 渲染表格，可切回原始 JSON', async () => {
  const calls = vi.fn(() => ({
    structuredContent: {
      totalCount: 2,
      issues: [
        { number: 1, title: '测试', state: 'OPEN', html_url: 'https://github.com/x/y/issues/1' },
        { number: 2, title: '第二个', state: 'CLOSED', labels: ['bug'] },
      ],
      pageInfo: { hasNextPage: false },
    },
    content: [{ type: 'text', text: '{"issues":[]}'}],
  }))
  const tool = { name: 'list_issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' } }, required: ['owner'] } }
  const { user } = mount('/admin/mcp-servers/team%201', (path, options) => {
    if (path === '/mcp-servers') return [server]
    if (path.endsWith('/inspection')) return { resources: [resource] }
    if (path.endsWith('/catalog/tools')) return [tool]
    if (path.endsWith('/settings')) return JSON.parse(String(options.body))
    return calls()
  })
  await user.click(await screen.findByRole('tab', { name: '工具目录' }))
  await user.click(await screen.findByRole('button', { name: 'list_issues' }))
  await user.type(screen.getByLabelText('参数 owner'), 'octocat')
  await user.click(screen.getByRole('switch', { name: '允许调用 list_issues' }))
  await user.click(screen.getByRole('button', { name: '调用工具' }))
  await user.click(screen.getByRole('button', { name: '确认调用' }))
  // 结构化视图: 表格 + 条数 + 顶层标量
  expect(await screen.findByText('issues · 2 条')).toBeVisible()
  expect(screen.getByText('totalCount')).toBeVisible()
  expect(screen.getByText('测试')).toBeVisible()
  expect(screen.getByRole('link', { name: 'https://github.com/x/y/issues/1' })).toHaveAttribute('href', 'https://github.com/x/y/issues/1')
  // 嵌套对象折叠
  expect(screen.getByText('pageInfo')).toBeVisible()
  // 切原始 JSON
  await user.click(screen.getByRole('tab', { name: '原始 JSON' }))
  expect(screen.getByText(/structuredContent/)).toBeVisible()
  // 切回结构化
  await user.click(screen.getByRole('tab', { name: '结构化' }))
  expect(screen.getByText('issues · 2 条')).toBeVisible()
})

it('无 structuredContent 时解析 content 文本 JSON 或展示原文', async () => {
  const calls = vi.fn(() => ({ content: [{ type: 'text', text: '调用成功' }] }))
  const tool = { name: 'echo' }
  const { user } = mount('/admin/mcp-servers/team%201', (path, options) => {
    if (path === '/mcp-servers') return [server]
    if (path.endsWith('/inspection')) return { resources: [resource] }
    if (path.endsWith('/catalog/tools')) return [tool]
    if (path.endsWith('/settings')) return JSON.parse(String(options.body))
    return calls()
  })
  await user.click(await screen.findByRole('tab', { name: '工具目录' }))
  await user.click(await screen.findByRole('button', { name: 'echo' }))
  await user.click(screen.getByRole('switch', { name: '允许调用 echo' }))
  await user.click(screen.getByRole('button', { name: '调用工具' }))
  await user.click(screen.getByRole('button', { name: '确认调用' }))
  expect(await screen.findByText(/调用成功/)).toBeVisible()
})


it('目录列表完整展示工具描述，名称单行截断', async () => {
  const longDescription = '列出仓库中的 issue。'.repeat(10)
  const tool = { name: 'list_issues_with_long_name_and_still_truncated', description: longDescription }
  const { user } = mount('/admin/mcp-servers/team%201', (path) => {
    if (path === '/mcp-servers') return [server]
    if (path.endsWith('/inspection')) return { resources: [resource] }
    if (path.endsWith('/catalog/tools')) return [tool]
    throw new Error(path)
  })
  await user.click(await screen.findByRole('tab', { name: '工具目录' }))
  await user.click(await screen.findByRole('button', { name: tool.name }))
  // 描述完整渲染（不折叠），名称容器截断
  for (const shown of screen.getAllByText(longDescription)) expect(shown).toBeVisible()
  for (const named of screen.getAllByTitle(tool.name)) expect(named).toHaveClass('truncate')
  // 选中态
  expect(screen.getByRole('button', { name: tool.name })).toHaveAttribute('aria-pressed', 'true')
})
