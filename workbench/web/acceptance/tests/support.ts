import { expect, type Page } from '@playwright/test'

/** 验收材料：固定文案，便于在页面、模型请求与证据里互相对照。 */
export const SOP1 = 'SOP-READ-THE-TICKET-v1'
export const SOP2 = 'SOP-READ-THE-TICKET-v2'
export const GUIDE1 = 'PROMPT-CHECK-THE-EVIDENCE-v1'
export const GUIDE2 = 'PROMPT-CHECK-THE-EVIDENCE-v2'
export const ACCEPTANCE1 = '核对报告结论与工单编号一致'
export const ACCEPTANCE2 = '核对报告结论、工单编号与回执截图说明'
export const MODEL_ANSWER = 'SIMULATED-MODEL: fixed report'

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 浏览器登录：令牌来自本次运行生成的运行时文件，由测试显式输入。 */
export async function login(page: Page, token: string) {
  await page.goto('/items')
  const field = page.getByLabel('访问令牌')
  await expect(field).toBeVisible()
  await field.fill(token)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '派工记录' })).toBeVisible()
}

/** 从地址里取出工作项标识。只看路径段，不把查询串当单号。 */
export function itemIdFromUrl(url: string) {
  const match = /^\/items\/(?!new$)([^/]+)$/.exec(new URL(url).pathname)
  if (!match) throw new Error(`地址里没有工作项标识：${url}`)
  return decodeURIComponent(match[1])
}

/** 等浏览器落到工作项详情地址（`/items/:id`，没有查询串）。 */
export async function waitForItemPage(page: Page) {
  await page.waitForURL(url => /^\/items\/(?!new$)[^/]+$/.test(url.pathname))
  return itemIdFromUrl(page.url())
}

/** 等待下拉框里的固定版本选项出现，再选中。 */
export async function selectRevision(page: Page, label: string, revision: number) {
  const select = page.getByLabel(label, { exact: true })
  await select.locator(`option[value="${revision}"]`).waitFor({ state: 'attached' })
  await select.selectOption(String(revision))
}

/** 小屏下从抽屉进入某个导航项，并确认抽屉关闭。 */
export async function viaDrawer(page: Page, title: string) {
  await page.getByRole('button', { name: '打开导航菜单' }).click()
  const drawer = page.getByRole('dialog', { name: '工作区导航' })
  await expect(drawer).toBeVisible()
  await drawer.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: title, exact: true }).click()
  await expect(drawer).toBeHidden()
}
