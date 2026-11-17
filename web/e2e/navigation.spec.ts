import { test, expect, expectNoOverflow, navigate, openNavigation } from './fixtures'

const entries = [
  { path: '/workflows', title: '工作流', heading: '工作流', content: '产品需求交付' },
  { path: '/roles', title: '角色管理', heading: '角色工作室', content: '产品分析师' },
  { path: '/runs', title: '运行记录', heading: '运行记录', content: '客户反馈看板 · 需求确认' },
  { path: '/artifacts', title: '产物管理', heading: '产物管理', content: '需求草案.md' },
  { path: '/sandboxes', title: '沙箱管理', heading: '沙箱管理', content: '交付工作区 01' },
  { path: '/connections', title: '模型连接', heading: '模型连接', content: '团队研发模型' },
]

test('六域真实内容、导航刷新、主题持久化与响应式布局', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await expect(page).toHaveURL(/\/workflows$/)
  for (const entry of entries) {
    await navigate(page, entry.title)
    await expect(page).toHaveURL(new RegExp(`${entry.path}$`))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(entry.heading)
    await expect(page).toHaveTitle(`${entry.title} · ursi-flow`)
    await expect(page.getByText(entry.content, { exact: true }).first()).toBeVisible()
    await expect(page.getByText('功能准备中', { exact: true })).toHaveCount(0)
    await expectNoOverflow(page)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(entry.heading)
    await expect(page.getByText(entry.content, { exact: true }).first()).toBeVisible()
    await expectNoOverflow(page)
  }

  await navigate(page, '角色管理')
  await expect(page.getByLabel('角色名称')).toHaveValue('产品分析师')
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') {
      await openNavigation(page)
      await page.getByRole('button', { name: '切换到暗色主题' }).click()
      const drawer = page.getByRole('dialog', { name: '工作区导航' })
      if (await drawer.isVisible()) await page.keyboard.press('Escape')
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.getByLabel('角色名称')).toHaveValue('产品分析师')
    await expectNoOverflow(page)
    const screenshot = testInfo.outputPath(`${testInfo.project.name}-roles-${theme}.png`)
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
    await testInfo.attach(`${testInfo.project.name}-${theme}`, { path: screenshot, contentType: 'image/png' })
  }
  await page.goto('/not-a-page')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('页面未找到')
  await page.getByRole('link', { name: '返回工作流', exact: true }).click()
  await expect(page).toHaveURL(/\/workflows$/)
})

test('键盘可跳过导航进入内容', async ({ page }) => {
  await page.goto('/roles')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('角色工作室')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main-content')).toBeFocused()
})

test('演示设置触发加载错误，重试恢复并支持搜索空态', async ({ page }) => {
  await page.goto('/workflows')
  await expect(page.getByRole('button', { name: '产品需求交付', exact: true })).toBeVisible()
  await openNavigation(page)
  await page.getByRole('button', { name: '演示模式', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '演示模式设置' })
  await settings.getByLabel('请求延迟').fill('100')
  await settings.getByRole('switch', { name: '让下一次请求失败' }).click()
  await settings.getByRole('button', { name: '保存设置' }).click()
  await expect(settings).toBeHidden()
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('服务暂时不可用，请重试。')
  await page.getByRole('button', { name: '重新加载' }).click()
  await expect(page.getByRole('button', { name: '产品需求交付', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('searchbox', { name: '搜索工作流' }).fill('不存在的验收工作流')
  await expect(page.getByRole('heading', { name: '没有匹配的工作流' })).toBeVisible()
  await page.getByRole('button', { name: '清除搜索' }).click()
  await expect(page.getByRole('button', { name: '产品需求交付', exact: true })).toBeVisible()
  await expectNoOverflow(page)
})
