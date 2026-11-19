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

/** 用应用内导航回到工作清单，避免整页刷新受并行构建产物替换影响。 */
export async function goToWorkList(page: Page) {
  const menu = page.getByRole('button', { name: '打开导航菜单' })
  if (await menu.isVisible()) {
    await menu.click()
    const drawer = page.getByRole('dialog', { name: '工作区导航' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '工作清单', exact: true }).click()
    await expect(drawer).toBeHidden()
  } else {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '工作清单', exact: true }).click()
  }
  await expect(page.getByRole('heading', { level: 1, name: '工作清单' })).toBeVisible()
}

/** 从旧工作清单进入工作区列表。 */
export async function openWorkspaces(page: Page) {
  await page.getByRole('link', { name: '报告工作区', exact: true }).click()
  await page.waitForURL(url => url.pathname === '/workspaces')
  await expect(page.getByRole('heading', { level: 1, name: '线索报告工作区' })).toBeVisible()
}

/** 在工作区列表里按完整需求打开对应工作单。 */
export async function openWorkspace(page: Page, requirement: string) {
  await page.goto('/workspaces')
  await expect(page.getByRole('heading', { level: 1, name: '线索报告工作区' })).toBeVisible()
  return openWorkspaceRow(page, requirement)
}

/** 在当前工作区列表里点开一行。 */
export async function openWorkspaceRow(page: Page, requirement: string) {
  await page.getByRole('link').filter({ hasText: requirement }).first().click()
  await page.waitForURL(url => /^\/workspaces\/[^/]+$/.test(url.pathname) && url.pathname !== '/workspaces/new')
  await expect(page.getByRole('heading', { level: 1, name: '准备工作区' })).toBeVisible()
  return workspaceIdFromUrl(page.url())
}

/** 从工作区列表新建一张工作单，返回地址里的工作区标识。 */
export async function createWorkspace(page: Page, requirement: string) {
  await page.getByRole('link', { name: '新建工作区' }).first().click()
  await page.waitForURL(url => url.pathname === '/workspaces/new')
  await expect(page.getByRole('heading', { level: 1, name: '新建线索报告工作区' })).toBeVisible()
  await page.getByLabel('工作区类型', { exact: true }).selectOption('finding-report')
  await page.getByLabel('需求', { exact: true }).fill(requirement)
  await page.getByRole('button', { name: '创建工作区' }).click()
  await page.waitForURL(url => /^\/workspaces\/[^/]+$/.test(url.pathname) && url.pathname !== '/workspaces/new')
  await expect(page.getByRole('heading', { level: 1, name: '准备工作区' })).toBeVisible()
  return workspaceIdFromUrl(page.url())
}

export function workspaceIdFromUrl(url: string) {
  const match = /^\/workspaces\/([^/]+?)(?:\/result)?$/.exec(new URL(url).pathname)
  if (!match) throw new Error(`地址里没有工作区标识：${url}`)
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
}

/** 在工作区详情里保存需求。 */
export async function saveRequirement(page: Page, requirement: string) {
  await page.getByLabel('需求', { exact: true }).fill(requirement)
  await page.getByRole('button', { name: '保存需求' }).click()
  await expect(page.getByRole('status')).toContainText('需求已保存', { timeout: 20_000 })
}

/** 从准备页执行一次并落到结果页。 */
export async function executeOnce(page: Page) {
  await page.getByRole('button', { name: '执行一次' }).click()
  await page.waitForURL(url => /^\/workspaces\/[^/]+\/result$/.test(url.pathname))
  await expect(page.getByRole('heading', { level: 1, name: '执行结果' })).toBeVisible()
  return page.url()
}

/** 在结果页再执行一次，等到尝试行数量增加后返回。 */
export async function executeAgain(page: Page) {
  const viewButtons = page.getByRole('button', { name: /^查看回执 / })
  const before = await viewButtons.count()
  await page.getByRole('button', { name: '再执行一次' }).click()
  await expect.poll(() => viewButtons.count(), { timeout: 30_000 }).toBe(before + 1)
}

/** 点开某次尝试的回执预览，返回预览正文。 */
export async function previewReceipt(page: Page, attempt: string) {
  await page.getByRole('button', { name: `查看回执 ${attempt}` }).click()
  const pre = page.locator('pre').last()
  await expect(pre).toBeVisible()
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
