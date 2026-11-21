import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { readRuntime } from '../fixtures/runtime'
import { login } from './support'

test('只填标题创建工作项，类别和状态可分别修改并保存', async ({ page }, info) => {
  await login(page, readRuntime().token)
  await page.getByRole('link', { name: '新建工作项' }).click()
  const title = `材料核查-${info.project.name}`
  const category = page.getByRole('combobox', { name: '类别', exact: true })
  const status = page.getByRole('combobox', { name: '状态', exact: true })
  const save = page.getByRole('button', { name: '保存工作项' })
  const edit = page.getByRole('link', { name: '编辑工作项' })
  await expect(category).toHaveValue('one_time')
  await expect(status).toHaveCount(0)
  await page.getByLabel('标题').fill(title)
  await save.click()
  await expect(page.getByText('一次性工作', { exact: true })).toBeVisible()
  await expect(page.getByText('待开始', { exact: true })).toBeVisible()
  await edit.click()
  await status.selectOption('active')
  await save.click()
  await expect(page.getByText('一次性工作', { exact: true })).toBeVisible()
  await expect(page.getByText('进行中', { exact: true })).toBeVisible()
  await edit.click()
  await expect(status).toHaveValue('active')
  await category.selectOption('continuous')
  await save.click()
  await expect(page.getByText('持续工作', { exact: true })).toBeVisible()
  await expect(page.getByText('进行中', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '返回工作清单' }).click()
  const row = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: title, exact: true }) })
  await expect(row).toContainText('持续工作')
  await expect(row).toContainText('进行中')
})

test('清单：从所选 MCP 资源生成文件包，删除工作项后仍可读取', async ({ page, request }, info) => {
  const { token, apiBase } = readRuntime()
  const title = `每周反馈-${info.project.name}`
  const uri = 'feedback://weekly'
  const modern = info.project.name === 'desktop'
  const toolCalls: unknown[] = []
  const peer = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return }
    const body = []
    for await (const bytes of req) body.push(bytes)
    const rpc = JSON.parse(Buffer.concat(body).toString())
    if (rpc.method === 'server/discover' && !modern) { res.writeHead(400).end(); return }
    if (modern && (rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28' || req.headers['mcp-protocol-version'] !== '2026-07-28')) { res.writeHead(422).end(); return }
    if (rpc.method === 'notifications/initialized') { res.writeHead(202).end(); return }
    const result = rpc.method === 'server/discover' ? {
      supportedVersions: ['2026-07-28','2025-06-18'], capabilities: { resources: { listChanged: true }, tools: {}, prompts: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: '现代服务', version: '2' } },
    } : rpc.method === 'initialize' ? {
      protocolVersion: '2025-06-18', capabilities: { resources: {}, tools: {}, prompts: {} }, serverInfo: { name: '反馈', version: '1' },
    } : rpc.method === 'resources/list' ? { resources: [{ name: '周报', uri }] }
      : rpc.method === 'tools/list' ? (rpc.params?.cursor ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'two' })
      : rpc.method === 'tools/call' ? { content: [{ type: 'text', text: '回声结果' }] }
      : rpc.method === 'prompts/list' ? { prompts: [{ name: 'welcome', arguments: [{ name: 'user' }] }] }
      : rpc.method === 'prompts/get' ? { messages: [{ role: 'user', content: { type: 'text', text: `你好 ${rpc.params.arguments.user}` } }] }
      : rpc.method === 'resources/templates/list' ? { resourceTemplates: [{ name: '周报模板', uriTemplate: 'feedback://{week}' }] }
      : { contents: [{ uri: rpc.params.uri, text: '本周反馈原文' }] }
    if (rpc.method === 'tools/call') toolCalls.push(rpc.params.arguments)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...result } : result }))
  })
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(peer.address() as AddressInfo).port}/mcp`
  try {
    await login(page, token)
    const key = `MCP_TEST_${info.project.name.toUpperCase()}`
    await page.goto('/platform-env')
    await page.getByRole('button', { name: '新增变量' }).click()
    await page.getByLabel('变量名').fill(key)
    await page.getByLabel('新值').fill('fixture-token')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText(key, { exact: true })).toBeVisible()
    await page.goto('/mcp-servers')
    await page.getByRole('button', { name: '登记服务' }).click()
    await page.getByLabel('服务名称').fill(title)
    await page.getByLabel('服务地址').fill(url)
    await page.getByLabel('平台凭据').selectOption(key)
    await page.getByRole('button', { name: '添加服务' }).click()
    await expect(page.getByText(url, { exact: true })).toBeVisible()
    const search = page.getByRole('searchbox', { name: '搜索服务' })
    await search.fill('不存在的服务')
    await expect(page.getByText('没有匹配的服务')).toBeVisible()
    await search.fill(title)
    await page.getByRole('listitem').filter({ hasText: title }).getByRole('link', { name: '浏览资源' }).click()
    await expect(page.getByText(modern ? '2026-07-28、2025-06-18' : '未报告版本列表')).toBeVisible()
    await expect(page.getByText(modern ? '现代服务 · 2' : '反馈 · 1')).toBeVisible()
    await expect(page.getByRole('table', { name: '资源列表' })).toBeVisible()
    await page.getByRole('button', { name: '工具目录' }).click()
    await page.getByRole('table', { name: '工具目录' }).getByRole('button', { name: 'echo' }).click()
    await expect(page.getByRole('button', { name: '调用工具' })).toBeDisabled()
    const endpoint = `${apiBase}/api/v2${new URL(page.url()).pathname}/tools/call`
    const denied = await request.post(endpoint, { headers: { Authorization: `Bearer ${token}` }, data: { name: 'echo', arguments: {} } })
    expect(denied.status()).toBe(400)
    expect(toolCalls).toHaveLength(0)
    await page.getByRole('switch', { name: '允许调用 echo' }).click()
    await expect(page.getByRole('switch', { name: '允许调用 echo' })).toBeChecked()
    await page.getByLabel('调用参数').fill('{"note":"hello"}')
    await page.getByRole('button', { name: '调用工具' }).click()
    await page.getByRole('button', { name: '确认调用' }).click()
    await expect(page.locator('pre').filter({ hasText: '回声结果' })).toBeVisible()
    expect(toolCalls).toEqual([{ note: 'hello' }])
    await page.getByRole('button', { name: '提示词目录' }).click()
    await page.getByLabel('调用参数').fill('{"user":"Ada"}')
    await page.getByRole('button', { name: '获取提示词' }).click()
    await expect(page.locator('pre').filter({ hasText: '你好 Ada' })).toBeVisible()
    await page.getByRole('button', { name: '资源模板' }).click()
    await page.getByLabel('具体资源 URI').fill(uri)
    await page.getByRole('button', { name: '读取资源' }).click()
    await expect(page.locator('pre').filter({ hasText: '本周反馈原文' })).toBeVisible()
    await page.getByRole('button', { name: '资源浏览' }).click()
    await page.getByRole('button', { name: /周报/ }).click()
    await expect(page.getByRole('heading', { name: '周报' })).toBeVisible()
    await expect(page.getByText('本周反馈原文')).toBeVisible()
    await expect(page).toHaveURL(/uri=feedback%3A%2F%2Fweekly/)
    await page.reload()
    await expect(page.getByText('本周反馈原文')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.goto('/work-items/new')
    await page.getByLabel('标题').fill(title)
    await page.getByRole('combobox', { name: '类别', exact: true }).selectOption('continuous')
    await page.getByLabel('配置工作包来源').check()
    const option = page.getByLabel('资源服务').getByRole('option', { name: new RegExp(title) })
    await page.getByLabel('资源服务').selectOption(await option.getAttribute('value') as string)
    await page.getByLabel(`周报 · ${uri}`).check()
    await page.getByLabel('资源别名 1').fill('report')
    await page.getByLabel('Python 脚本').fill("def transform(item, resources):\n    return {'name': item['title'], 'files': [{'path':'feedback.txt','text':resources['report']['contents'][0]['text']}]}\n")
    await page.getByRole('button', { name: '保存工作项' }).click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    const detailUrl = page.url()
    await page.getByRole('button', { name: '生成工作包' }).click()
    await expect(page.getByTestId('patch-studio')).toBeVisible()
    const packageUrl = page.url()
    const headers = { Authorization: `Bearer ${token}` }
    const patch = await (await request.get(`${apiBase}/api/v2/patches/work/${packageUrl.split('/').at(-1)}`, { headers })).json()
    expect(patch.workItemId).toEqual(detailUrl.split('/').at(-1))
    await page.goto(detailUrl)
    await page.getByRole('link', { name: '编辑工作项' }).click()
    await expect(page.getByRole('combobox', { name: '类别', exact: true })).toHaveValue('continuous')
    const status = page.getByRole('combobox', { name: '状态', exact: true })
    await expect(status).toHaveValue('pending')
    await status.selectOption('completed')
    await page.getByRole('button', { name: '保存工作项' }).click()
    await expect(page.getByText('持续工作', { exact: true })).toBeVisible()
    await expect(page.getByText('已完成', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '删除工作项' }).click()
    await expect(page.getByRole('dialog')).toContainText('解除 1 个工作包')
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(page.getByRole('heading', { name: '工作清单' })).toBeVisible()
    await page.goto(packageUrl)
    await expect(page.getByText('未关联', { exact: true })).toBeVisible()
    const file = await request.get(`${apiBase}/api/v2/directories/${patch.directoryId}/file?path=feedback.txt`, { headers })
    expect(await file.text()).toBe('本周反馈原文')
    await page.goto('/mcp-servers')
    await page.getByRole('button', { name: `删除 ${title}`, exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('已生成的工作包会保留')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible()
    await page.getByRole('button', { name: `删除 ${title}`, exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.getByRole('link', { name: title, exact: true })).toHaveCount(0)
  } finally {
    peer.closeAllConnections()
    peer.close()
  }
})
