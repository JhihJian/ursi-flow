import { createServer } from 'node:http'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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
  await expect(status).toHaveValue('pending')
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
  const { token, dataDir, apiBase } = readRuntime()
  const title = `每周反馈-${info.project.name}`
  const uri = 'feedback://weekly'
  const peer = createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return }
    const body = []
    for await (const bytes of req) body.push(bytes)
    const rpc = JSON.parse(Buffer.concat(body).toString())
    if (rpc.method === 'notifications/initialized') { res.writeHead(202).end(); return }
    const result = rpc.method === 'initialize' ? {
      protocolVersion: '2025-06-18', capabilities: { resources: {} }, serverInfo: { name: '反馈', version: '1' },
    } : rpc.method === 'resources/list' ? { resources: [{ name: '周报', uri }] }
      : { contents: [{ uri: rpc.params.uri, text: '本周反馈原文' }] }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(peer.address() as AddressInfo).port}/mcp`
  const policy = join(dataDir, 'work', 'mcp-policy.json')
  try {
    await writeFile(policy, JSON.stringify([{ url }]), { mode: 0o600 })
    await login(page, token)
    await page.goto('/mcp-servers')
    await page.getByLabel('服务名称').fill(title)
    await page.getByLabel('服务地址').fill(url)
    await page.getByRole('button', { name: '添加服务' }).click()
    await expect(page.getByText(url, { exact: false })).toBeVisible()
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
  } finally {
    peer.closeAllConnections()
    peer.close()
    await unlink(policy).catch(() => {})
  }
})
