import { expect, test as base, type Page } from '@playwright/test'

// 每个用例使用 Playwright 独立浏览器上下文，由应用自行生成并持久化演示种子。
// 业务操作经过真实 UI 和应用 mock transport，不拦截或替换业务请求。
export const test = base.extend<{ browserErrors: void }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await use()
    expect(errors, '页面不应产生未处理的 JavaScript 错误').toEqual([])
  }, { auto: true }],
})
export { expect }

export async function openNavigation(page: Page) {
  // 首帧前路由可能在等待懒加载模块，先等应用壳出现再判断桌面侧边栏或移动菜单按钮。
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  const menu = page.getByRole('button', { name: '打开导航菜单' })
  if (await menu.isVisible()) await menu.click()
}

export async function navigate(page: Page, title: string) {
  await openNavigation(page)
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: title, exact: true }).click()
}

export async function expectNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport)
  expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport)
}
