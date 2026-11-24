import { expect, test } from '@playwright/test'

test('home stays usable with no plugins enabled and remembers preferences', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'ursi-flow' })).toBeVisible()
  const navigation = page.getByRole('navigation', { name: '应用导航' })
  await expect(navigation.getByRole('link', { name: /Workbench/ })).toHaveAttribute('href', 'http://127.0.0.1:5173/work-items')
  await expect(page.getByRole('button', { name: '应用导航' })).toBeHidden()
  const sidebar = page.getByRole('complementary')
  await expect(sidebar).toContainText('项目链接')
  const main = await page.getByRole('main').boundingBox()
  const aside = await sidebar.boundingBox()
  const nav = await navigation.boundingBox()
  expect(nav!.x + nav!.width).toBeLessThan(main!.x)
  expect(aside!.x).toBeGreaterThan(main!.x + main!.width)
  expect(aside!.y).toBe(main!.y)
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  await page.getByRole('button', { name: '布局设置' }).click()
  await page.getByRole('radio', { name: '下方' }).check()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '布局设置' })).toBeFocused()
  await expect(page.locator('[data-aside-placement]')).toHaveAttribute('data-aside-placement', 'below')

  await page.getByRole('button', { name: '插件管理' }).click()
  await page.getByRole('switch', { name: 'Workbench' }).uncheck()
  await page.getByRole('switch', { name: '项目链接' }).uncheck()
  await page.getByRole('button', { name: '关闭' }).click()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'ursi-flow' })).toBeVisible()
  await expect(page.getByText('暂无应用入口')).toBeVisible()
  await expect(page.getByRole('complementary')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '布局设置' })).toBeVisible()
  await page.getByRole('button', { name: '插件管理' }).click()
  await expect(page.getByRole('switch', { name: 'Workbench' })).not.toBeChecked()
  await page.getByRole('switch', { name: '项目链接' }).check()
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('complementary')).toContainText('项目链接')
  await expect(page.locator('[data-aside-placement]')).toHaveAttribute('data-aside-placement', 'below')
})

test('one unavailable plugin leaves other entries and settings usable', async ({ page }) => {
  await page.route('**/src/plugins/project-links.tsx*', route => route.abort())
  await page.goto('/')
  await expect(page.getByRole('link', { name: /Workbench/ })).toBeVisible()
  await page.getByRole('button', { name: '插件管理' }).click()
  await expect(page.getByRole('dialog')).toContainText('加载失败，请刷新页面')
  await expect(page.getByRole('dialog')).toContainText('已加载')
})

test('a contribution that fails to render does not break the portal', async ({ page }) => {
  await page.route('**/src/plugins/project-links.tsx*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export function activate({ slots }) {
      slots.register('home.aside', { id: 'broken', Component() { throw new Error('render failure') } })
      slots.register('home.aside', { id: 'working', Component() { return '同一插槽的另一条内容' } })
    }`,
  }))
  await page.goto('/')
  await expect(page.getByRole('complementary').getByRole('alert')).toHaveText('扩展内容加载失败。')
  await expect(page.getByRole('complementary')).toContainText('同一插槽的另一条内容')
  await expect(page.getByRole('link', { name: /Workbench/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '插件管理' })).toBeVisible()
})

test('narrow view keeps the settings and contributions within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: '应用导航' })
  const toggle = page.getByRole('button', { name: '应用导航' })
  await expect(navigation).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '项目仓库' })).toBeFocused()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const workbench = navigation.getByRole('link', { name: /Workbench/ })
  await workbench.focus()
  await expect(workbench).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(navigation).toBeHidden()
  await expect(toggle).toBeFocused()

  for (const name of ['布局设置', '插件管理']) {
    const button = page.getByRole('button', { name })
    await button.click()
    await expect(page.getByRole('dialog', { name })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(button).toBeFocused()
  }

  const aside = page.getByRole('complementary')
  await expect(aside).toBeVisible()
  for (const width of [360, 768, 880, 1024]) {
    await page.setViewportSize({ width, height: 740 })
    const mainBox = (await page.getByRole('main').boundingBox())!
    const asideBox = (await aside.boundingBox())!
    if (width < 1024) expect(asideBox.y).toBeGreaterThan(mainBox.y + mainBox.height)
    else expect(asideBox.x).toBeGreaterThan(mainBox.x + mainBox.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  }
})
