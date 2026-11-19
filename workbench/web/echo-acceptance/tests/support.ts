import { expect, type Download, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

/** 浏览器登录：令牌来自本次运行生成的运行时文件，由测试显式输入。 */
export async function login(page: Page, token: string) {
  await page.goto('/items')
  const field = page.getByLabel('访问令牌')
  await expect(field).toBeVisible()
  await field.fill(token)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '工作清单' })).toBeVisible()
}

/** 打开工作包列表。列表标题与导航都使用「工作包」。 */
export async function openWorkspaces(page: Page) {
  await page.goto('/workspaces')
  await expect(page.getByRole('heading', { level: 1, name: '工作包' })).toBeVisible()
}

/**
 * 从旧 `/packages/new` 入口进入新建工作包。真实组件地址是 `/workspaces/new`，
 * 旧地址只做重定向。
 */
export async function openNewWorkspaceFromPackagesEntry(page: Page) {
  await page.goto('/packages/new')
  await page.waitForURL(url => url.pathname === '/workspaces/new')
  await expect(page.getByRole('heading', { level: 1, name: '新建工作包' })).toBeVisible()
}

/** 从工作包列表里的「新建工作包」进入表单。 */
export async function openNewWorkspace(page: Page) {
  await page.getByRole('link', { name: '新建工作包' }).first().click()
  await page.waitForURL(url => url.pathname === '/workspaces/new')
  await expect(page.getByRole('heading', { level: 1, name: '新建工作包' })).toBeVisible()
}

/** 在当前工作包列表里点开一行。 */
export async function openWorkspaceRow(page: Page, requirement: string) {
  await page.getByRole('link').filter({ hasText: requirement }).first().click()
  await page.waitForURL(url => /^\/workspaces\/[^/]+$/.test(url.pathname) && url.pathname !== '/workspaces/new')
  await expect(page.getByRole('heading', { level: 1, name: '准备工作包' })).toBeVisible()
  return workspaceIdFromUrl(page.url())
}

/** 在工作包列表里按完整需求打开对应工作包。 */
export async function openWorkspace(page: Page, requirement: string) {
  await openWorkspaces(page)
  return openWorkspaceRow(page, requirement)
}

/** 在新建页填写类型和需求，返回地址里的工作包标识。 */
export async function createWorkspace(page: Page, requirement: string) {
  await expect(page.getByRole('heading', { level: 1, name: '新建工作包' })).toBeVisible()
  await page.getByLabel('工作包类型', { exact: true }).selectOption('finding-report')
  await page.getByLabel('需求', { exact: true }).fill(requirement)
  await page.getByRole('button', { name: '创建工作包' }).click()
  await page.waitForURL(url => /^\/workspaces\/[^/]+$/.test(url.pathname) && url.pathname !== '/workspaces/new')
  await expect(page.getByRole('heading', { level: 1, name: '准备工作包' })).toBeVisible()
  return workspaceIdFromUrl(page.url())
}

export function workspaceIdFromUrl(url: string) {
  const match = /^\/workspaces\/([^/]+?)(?:\/result)?$/.exec(new URL(url).pathname)
  if (!match) throw new Error(`地址里没有工作包标识：${url}`)
  return decodeURIComponent(match[1])
}

/** 上传某个角色的材料。文件名按原始名称提交，内容按字节上传。 */
export async function uploadMaterial(page: Page, roleLabel: string, name: string, content: string) {
  await page.locator(`input[type=file][aria-label="选择${roleLabel}材料文件"]`).setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(content, 'utf8'),
  })
  await page.getByRole('button', { name: `上传${roleLabel}材料` }).click()
  await expect(page.getByRole('status')).toContainText(`${name} 已上传`, { timeout: 20_000 })
  // 同名文件会让两次上传的状态文案相同，再以该角色已收存（文件选择框禁用）确认本次写入完成。
  await expect(page.locator(`input[type=file][aria-label="选择${roleLabel}材料文件"]`)).toBeDisabled({ timeout: 20_000 })
}

/** 在工作包详情里保存需求。 */
export async function saveRequirement(page: Page, requirement: string) {
  await page.getByLabel('需求', { exact: true }).fill(requirement)
  await page.getByRole('button', { name: '保存需求' }).click()
  await expect(page.getByRole('status')).toContainText('需求已保存', { timeout: 20_000 })
}

/**
 * 从 /sops/new 用真实表单发布指定标识与标题的 SOP，返回服务端分配的修订号。
 * 标识已存在时追加新修订，旧修订保持不变。
 */
export async function publishSop(page: Page, id: string, title: string) {
  await page.goto('/sops/new')
  await expect(page.getByRole('heading', { level: 1, name: '发布 SOP' })).toBeVisible()
  await expect(page.getByLabel('执行器')).toHaveValue('echo')
  await page.getByLabel('SOP 标识').fill(id)
  await page.getByLabel('回执标题').fill(title)
  await page.getByRole('button', { name: '发布 SOP' }).click()
  await page.waitForURL(url => new RegExp(`^/sops/${id}/revisions/\\d+$`).test(url.pathname))
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  const match = /\/revisions\/(\d+)$/.exec(new URL(page.url()).pathname)
  if (!match) throw new Error(`地址里没有 SOP 修订号：${page.url()}`)
  return { id, revision: Number(match[1]), title }
}

/** 在执行控件里等待已发布版本加载完成，必要时显式选择版本（值形如 receipt@2）。 */
export async function chooseSop(page: Page, key?: string) {
  const select = page.getByLabel('SOP 版本')
  await expect(select).toBeEnabled({ timeout: 20_000 })
  if (key) {
    await select.selectOption(key)
    await expect(select).toHaveValue(key)
  }
  return select.inputValue()
}

/** 从准备页执行一次并落到结果页。sopKey 省略时使用类型推荐的默认版本。 */
export async function executeOnce(page: Page, sopKey?: string) {
  await chooseSop(page, sopKey)
  await page.getByRole('button', { name: '执行一次' }).click()
  await page.waitForURL(url => /^\/workspaces\/[^/]+\/result$/.test(url.pathname))
  await expect(page.getByRole('heading', { level: 1, name: '执行结果' })).toBeVisible()
  return page.url()
}

/** 在结果页选择版本后再执行一次，等到尝试行数量增加后返回。 */
export async function executeAgain(page: Page, sopKey?: string) {
  const viewButtons = page.getByRole('button', { name: /^查看回执 / })
  const before = await viewButtons.count()
  await chooseSop(page, sopKey)
  await page.getByRole('button', { name: '再执行一次' }).click()
  await expect.poll(() => viewButtons.count(), { timeout: 30_000 }).toBe(before + 1)
}

/**
 * 点开某次尝试的回执预览，返回预览正文。
 * 传入服务端正文时等到页面显示同一份内容，避免旧尝试的预览还没切换就被读走。
 */
export async function previewReceipt(page: Page, attempt: string, expected?: string) {
  await page.getByRole('button', { name: `查看回执 ${attempt}` }).click()
  const pre = page.locator('pre').last()
  await expect(pre).toBeVisible()
  if (expected !== undefined) {
    await expect.poll(async () => pre.textContent(), { timeout: 20_000 }).toBe(expected)
  }
  return (await pre.textContent()) ?? ''
}

/** 通过页面按钮下载回执，返回浏览器保存的字节与建议文件名。 */
export async function downloadReceipt(page: Page, attempt: string): Promise<{ download: Download; bytes: Buffer; text: string }> {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: `下载回执 ${attempt}` }).click()
  const download = await pending
  const file = await download.path()
  if (!file) throw new Error('浏览器没有保存下载文件')
  const bytes = readFileSync(file)
  return { download, bytes, text: bytes.toString('utf8') }
}

/** 窄屏也要求页面不出现横向溢出。 */
export async function expectNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport)
  expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport)
}
