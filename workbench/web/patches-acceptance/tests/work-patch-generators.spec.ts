import { createHash, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { mcpResource, mcpToken, startMcpFixture } from '../fixtures/mcp'
import { readRuntime } from '../fixtures/runtime'
import { PatchApi } from './patches-support'
import { login } from './support'

const generators = '/work-patch-generators'
const runs = '/work-patch-generation-runs'
const file = 'feedback.txt'

interface GeneratorRef { id: string; revision: number }
interface ResourceRef { alias: string; serverId: string; uri: string }
interface Run {
  id: string
  generator: GeneratorRef
  workItemId?: string
  resources: ResourceRef[]
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  evidence?: { sha256: string }[]
  error?: { stage: string; message: string }
  result?: {
    name: string
    directoryId: string
    workPatchId?: string | null
    files: { path: string; bytes: number; sha256: string }[]
  } | null
}

function workApi(request: APIRequestContext) {
  const { apiBase, token } = readRuntime()
  const send = (method: string, path: string, data?: unknown) => request.fetch(`${apiBase}/api/v2${path}`, {
    method, data, headers: { Authorization: `Bearer ${token}` }, timeout: method === 'PUT' ? 50_000 : 10_000,
  })
  async function json<T>(method: string, path: string, data?: unknown): Promise<T> {
    const response = await send(method, path, data)
    expect(response.ok(), `${method} ${path}: HTTP ${response.status()} ${await response.text()}`).toBe(true)
    return response.json() as Promise<T>
  }
  return { send, json }
}

async function completedRun(api: ReturnType<typeof workApi>, path: string, expected: Pick<Run, 'generator' | 'resources'> & { workItemId?: string }) {
  let record: Run | undefined
  await expect.poll(async () => {
    record = await api.json<Run>('GET', path)
    return record.status
  }, { timeout: 50_000, message: `${path} 应进入终态` }).not.toBe('running')
  expect(record, JSON.stringify(record)).toMatchObject({ id: path.split('/').at(-1), status: 'succeeded', ...expected })
  if (!record?.result) throw new Error(`${path} 没有生成结果`)
  return record.result
}

async function openNavigation(page: Page, mobile: boolean, name: string, path: string) {
  const drawer = page.getByRole('dialog', { name: '工作区导航' })
  if (mobile) await page.getByRole('button', { name: '打开导航菜单' }).click()
  const nav = (mobile ? drawer : page).getByRole('navigation', { name: '主导航' })
  const link = nav.getByRole('link', { name, exact: true })
  await expect(link).toHaveAttribute('href', path)
  await link.click()
  await expect(page).toHaveURL(url => url.pathname === path)
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
  if (mobile) await expect(drawer).toBeHidden()
}

function linkTo(page: Page, path: string) {
  return page.getByRole('link').and(page.locator(`a[href="${path}"]`))
}

async function submitFromBrowser(page: Page, button: string, payload: unknown) {
  const prefix = `/api/v2${runs}/`
  const [response] = await Promise.all([
    page.waitForResponse(res => res.request().method() === 'PUT' && new URL(res.url()).pathname.startsWith(prefix), { timeout: 50_000 }),
    page.getByRole('button', { name: button, exact: true }).click(),
  ])
  expect(response.request().postDataJSON()).toEqual(payload)
  const path = new URL(response.url()).pathname.slice('/api/v2'.length)
  expect(response.ok(), `PUT ${path}: HTTP ${response.status()} ${await response.text()}`).toBe(true)
  expect(path.slice(`${runs}/`.length)).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  return path
}

function script(version: number) {
  // 版本和调用模式故意落进正文，以区分错用最新版本、漏传 item 和未读 MCP。
  return `def transform(item, resources):
    mode = item['title'] if item is not None else 'trial'
    content = resources['report']['contents'][0]['text']
    return {'name': '反馈 v${version} ' + mode, 'files': [{'path': '${file}', 'text': 'v${version} | ' + mode + ' | ' + content}]}
`
}

async function expectOutput(patches: PatchApi, result: NonNullable<Run['result']>, version: number, mode: string) {
  const content = `v${version} | ${mode} | ${mcpResource.text}`
  expect(result.name).toBe(`反馈 v${version} ${mode}`)
  expect(result.files).toEqual([
    { path: file, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') },
  ])
  expect(await patches.text(result.directoryId, file)).toBe(content)
  return content
}

test('主导航可打开工作包生成器和生成记录', async ({ page }, info) => {
  await login(page, readRuntime().token)
  const mobile = info.project.name === 'mobile'
  await openNavigation(page, mobile, '工作包生成器', generators)
  await openNavigation(page, mobile, '生成记录', runs)
})

test('工作包生成器：试运行、关联工作项生成、重试及记录深链', async ({ page, request }, info) => {
  test.setTimeout(150_000)
  const mobile = info.project.name === 'mobile'
  const api = workApi(request)
  const patches = new PatchApi()
  const fixture = await startMcpFixture(!mobile)
  const key = `MCP_GENERATOR_${info.project.name.toUpperCase()}`
  const generatorId = `feedback-${info.project.name}-${randomUUID().slice(0, 8)}`
  const generatorName = `周报生成器 ${generatorId}`
  const title = `材料整理 ${generatorId}`

  try {
    const resources = await test.step('登记 MCP 服务并固定输入别名', async () => {
      await api.json('POST', '/platform-env', { name: key, value: mcpToken })
      const { id: serverId } = await api.json<{ id: string }>('POST', '/mcp-servers', {
        name: generatorName, url: fixture.url, credentialEnv: key, binding: 'platform',
      })
      return [{ alias: 'report', serverId, uri: mcpResource.uri }] satisfies ResourceRef[]
    })
    async function publish(revision: number): Promise<GeneratorRef> {
      const main = page.getByRole('main')
      if (revision === 1) {
        await page.goto(`${generators}/new`)
        await main.getByLabel('生成器 ID').fill(generatorId)
        await main.getByLabel('名称').fill(generatorName)
        await main.getByLabel('输入别名（每行一个）').fill('report')
      } else {
        await page.goto(`${generators}/${generatorId}`)
        await main.getByRole('link', { name: '发布新版' }).click()
        await expect(main.getByLabel('生成器 ID')).toHaveValue(generatorId)
      }
      await main.getByLabel('Python 脚本').fill(script(revision))
      await main.getByRole('button', { name: revision === 1 ? '发布生成器' : '发布新版', exact: true }).click()
      const versionPath = `${generators}/${generatorId}/revisions/${revision}`
      await expect(page).toHaveURL(url => url.pathname === versionPath)
      expect(await api.json('GET', versionPath)).toMatchObject({ id: generatorId, name: generatorName, aliases: ['report'], script: script(revision), revision })
      return { id: generatorId, revision }
    }

    const { v1, trialPath, trialContent } = await test.step('从主导航打开生成器并独立试运行第 1 版', async () => {
      await login(page, patches.token)
      await openNavigation(page, mobile, '工作包生成器', generators)
      const v1 = await publish(1)
      await expect(page.getByRole('heading', { level: 1, name: generatorName, exact: true })).toBeVisible()
      const trial = page.getByRole('button', { name: '试运行', exact: true })
      await expect(trial).toBeDisabled()
      await page.getByRole('combobox', { name: 'report 的 MCP 服务' }).selectOption(resources[0].serverId)
      await page.getByRole('combobox', { name: 'report 的 MCP 资源' }).selectOption(resources[0].uri)
      const payload = { generator: v1, resources }
      const trialPath = await submitFromBrowser(page, '试运行', payload)
      const result = await completedRun(api, trialPath, payload)
      await expect(page).toHaveURL(url => url.pathname === trialPath)
      expect(result.workPatchId ?? null).toBeNull()
      const trialContent = await expectOutput(patches, result, 1, 'trial')
      expect((await patches.list('work')).filter(patch => patch.directoryId === result.directoryId)).toEqual([])
      return { v1, trialPath, trialContent }
    })

    const item = await test.step('创建工作项，再发布并试运行第 2 版', async () => {
      const item = await api.json<{ id: string }>('POST', '/work-items', { title, category: 'continuous' })
      const v2 = await publish(2)
      const trialPath = `${runs}/${randomUUID()}`
      const payload = { generator: v2, resources }
      await api.json<Run>('PUT', trialPath, payload)
      await expectOutput(patches, await completedRun(api, trialPath, payload), 2, 'trial')
      expect(await api.json('GET', `/work-items/${item.id}`)).toMatchObject({ title, category: 'continuous', status: 'pending' })
      expect(fixture.resourceReads).toEqual([mcpResource.uri, mcpResource.uri])
      return item
    })

    await test.step('从主导航打开生成记录，重载旧试运行深链并读取文件', async () => {
      await openNavigation(page, mobile, '生成记录', runs)
      await linkTo(page, trialPath).click()
      await expect(page).toHaveURL(url => url.pathname === trialPath)
      await page.reload()
      const main = page.getByRole('main')
      const result = main.getByRole('region', { name: '生成结果' })
      await expect(main.getByRole('status').filter({ hasText: /^成功$/ })).toBeVisible()
      await expect(result.getByText('反馈 v1 trial', { exact: true })).toBeVisible()
      await expect(result.getByRole('heading', { name: '结果文件（只读）' })).toBeVisible()
      await result.getByRole('button', { name: file, exact: true }).click()
      await expect(result.getByLabel(`${file} 内容`)).toHaveText(trialContent)
      await expect(result.getByRole('button', { name: '下载文件' })).toBeVisible()
      await expect(result.getByRole('link', { name: '打开工作包' })).toHaveCount(0)
      const oldVersion = `${generators}/${generatorId}/revisions/1`
      const versionLink = main.getByRole('link', { name: `${generatorId} · 第 1 版`, exact: true })
      await expect(versionLink).toHaveAttribute('href', oldVersion)
      await versionLink.click()
      await expect(page).toHaveURL(url => url.pathname === oldVersion)
      await main.getByText('Python 脚本', { exact: true }).click()
      await expect(main.locator('pre')).toHaveText(script(1).trim())
    })

    const itemPath = `/work-items/${item.id}`
    const { runPath, patchPath } = await test.step('以工作项为上下文生成，核对旧版、归属及同 ID 重试', async () => {
      const payload = { generator: v1, resources, workItemId: item.id }
      const runPath = `${runs}/${randomUUID()}`
      await api.json<Run>('PUT', runPath, payload)
      const result = await completedRun(api, runPath, payload)
      await expectOutput(patches, result, 1, title)
      const patchId = result.workPatchId
      if (!patchId) throw new Error(`${runPath} 没有关联工作包`)
      const patch = await api.json('GET', `/patches/work/${patchId}`)
      expect(patch).toMatchObject({ id: patchId, workItemId: item.id, directoryId: result.directoryId })
      await expect(page).toHaveURL(url => url.pathname === runPath)
      const retry = await api.json<Run>('PUT', runPath, payload)
      expect(retry).toMatchObject({ status: 'succeeded', result })
      const conflict = await api.send('PUT', runPath, { generator: v1, resources })
      expect(conflict.status()).toBe(409)
      expect(fixture.resourceReads).toEqual([mcpResource.uri, mcpResource.uri, mcpResource.uri])
      expect((await patches.list('work')).filter(patch => patch.name === result.name).map(patch => patch.id)).toEqual([patchId])
      return { runPath, patchPath: `/work-patches/${patchId}` }
    })

    await test.step('由工作项进入对应记录，由记录打开工作包，再从来源回到同一记录', async () => {
      await page.goto(itemPath)
      const main = page.getByRole('main')
      await expect(main.getByText('持续工作', { exact: true })).toBeVisible()
      await expect(main.getByText('待开始', { exact: true })).toBeVisible()
      await expect(linkTo(page, patchPath)).toHaveText(`反馈 v1 ${title}`)
      await main.getByRole('link', { name: '查看本项的生成记录' }).click()
      await expect(page).toHaveURL(url => url.pathname === runs && url.searchParams.get('workItemId') === item.id)
      const boundRecord = linkTo(page, runPath)
      await expect(boundRecord).toBeVisible()
      await expect(linkTo(page, trialPath)).toHaveCount(0)
      await boundRecord.click()
      await expect(page).toHaveURL(url => url.pathname === runPath)
      await expect(linkTo(page, itemPath)).toHaveText(title)
      const removed = await api.send('DELETE', itemPath)
      expect(removed.status()).toBe(204)
      expect(await api.json('GET', runPath)).toMatchObject({ workItemId: item.id, status: 'succeeded' })
      expect(await api.json('GET', `/patches/work/${patchPath.split('/').at(-1)}`)).toMatchObject({ workItemId: null })
      const patchLink = main.getByRole('link', { name: '打开工作包', exact: true })
      await expect(patchLink).toHaveAttribute('href', patchPath)
      await patchLink.click()
      await expect(page).toHaveURL(url => url.pathname === patchPath)
      await expect(page.getByTestId('patch-studio')).toBeVisible()
      await page.getByRole('button', { name: '生成来源', exact: true }).click()
      const origin = page.getByRole('dialog', { name: '生成来源' }).getByRole('link', { name: '查看生成记录' })
      await expect(origin).toHaveAttribute('href', runPath)
      await origin.click()
      await expect(page).toHaveURL(url => url.pathname === runPath)
      await expect(patchLink).toBeVisible()
    })
  } finally {
    await fixture.close()
  }
})

test('工作包生成失败保留阶段与输入摘要，不发布目录或包', async ({ request }, info) => {
  test.skip(info.project.name !== 'desktop', '失败语义仅验证服务端')
  const api = workApi(request)
  let afterRead: (() => Promise<void>) | undefined
  const fixture = await startMcpFixture(true, async () => { await afterRead?.() })
  try {
    const credentialEnv = 'MCP_GENERATOR_FAILURES'
    await api.json('POST', '/platform-env', { name: credentialEnv, value: mcpToken })
    const { id: serverId } = await api.json<{ id: string }>('POST', '/mcp-servers', {
      name: '生成失败夹具', url: fixture.url, credentialEnv, binding: 'platform',
    })
    const id = `failure-${randomUUID()}`
    const definition = { id, name: '生成失败夹具', aliases: ['report'] }
    const v1 = await api.json<GeneratorRef>('POST', generators, { ...definition, script: `def transform(item, resources):
    return {'name': '非法产物', 'files': []}` })
    const v2 = await api.json<GeneratorRef>('POST', generators, { ...definition, script: script(2) })
    const resources = [{ alias: 'report', serverId, uri: mcpResource.uri }]
    const generator = { id, revision: v2.revision, resources }
    const item = await api.json<{ id: string }>('POST', '/work-items', { title: '读取时已删除', generator })
    const directoriesBefore = await api.json('GET', '/directories')
    const patchesBefore = await api.json('GET', '/patches/work')

    async function fails(payload: unknown, stage: string, evidenceCount: number) {
      const path = `${runs}/${randomUUID()}`
      const accepted = await api.json<Run>('PUT', path, payload)
      expect(accepted.status).toBe('running')
      let record: Run | undefined
      await expect.poll(async () => {
        record = await api.json<Run>('GET', path)
        return record.status
      }).toBe('failed')
      expect(record?.error).toMatchObject({ stage, message: expect.any(String) })
      expect(record?.evidence).toHaveLength(evidenceCount)
      expect(record?.result).toBeUndefined()
      expect(JSON.stringify(record)).not.toContain(mcpResource.text)
      expect(JSON.stringify(record)).not.toContain(mcpToken)
      expect(await api.json('PUT', path, payload)).toEqual(record)
    }

    await fails({ generator: { id, revision: v1.revision }, resources: [{ ...resources[0], uri: 'feedback://missing' }] }, 'read', 0)
    await fails({ generator: { id, revision: v1.revision }, resources }, 'validate', 1)
    afterRead = async () => {
      const removed = await api.send('DELETE', `/work-items/${item.id}`)
      expect(removed.status()).toBe(204)
    }
    await fails({ workItemId: item.id }, 'publish', 1)
    expect(await api.json('GET', '/directories')).toEqual(directoriesBefore)
    expect(await api.json('GET', '/patches/work')).toEqual(patchesBefore)
  } finally {
    await fixture.close()
  }
})
