import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const baseline = {
  schemaVersion: 1, revision: 'release-a',
  page: { brand: 'ursi-flow', name: 'ursi-flow', description: '项目资料', repository: 'https://github.com/JhihJian/ursi-flow', placement: 'right' },
  plugins: { workbench: true, 'project-links': true }, workbenchUrl: '/work-items',
}
type Config = typeof baseline

async function publish(page: Page, getConfig: () => Config = () => baseline) {
  await page.route('**/portal-config.json', route => route.fulfill({ json: getConfig() }))
}

test('page draft previews actual responsive home, survives reload, and exports without publishing', async ({ page, browser, baseURL }) => {
  await publish(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'ursi-flow' })).toBeVisible()
  await page.getByRole('link', { name: '页面管理' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '页面管理' })).toBeVisible()
  await page.getByRole('textbox', { name: '项目名称' }).fill('新项目名称')
  const preview = page.frameLocator('iframe[title="首页草稿预览"]')
  await expect(preview.getByRole('heading', { name: '新项目名称' })).toBeVisible()
  await expect(preview.getByRole('navigation', { name: '应用导航' })).toBeVisible()
  await page.getByRole('button', { name: '窄屏预览' }).click()
  await expect(preview.getByRole('navigation', { name: '应用导航' })).toBeHidden()
  await preview.getByRole('button', { name: '应用导航' }).click()
  await expect(preview.getByRole('link', { name: /Workbench/ })).toHaveAttribute('href', `${baseURL}/work-items`)
  await page.reload()
  await expect(page.getByRole('textbox', { name: '项目名称' })).toHaveValue('新项目名称')
  await page.getByRole('textbox', { name: '仓库地址' }).fill('example.com/repo')
  await expect(page.getByRole('alert')).toContainText('仓库地址须为')
  await expect(page.getByRole('button', { name: '导出配置' })).toBeDisabled()
  await page.getByRole('textbox', { name: '仓库地址' }).fill('/repo')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出配置' }).click()
  const exported = await download
  expect(exported.suggestedFilename()).toBe('portal-config.json')
  const data = JSON.parse(await readFile((await exported.path())!, 'utf8'))
  expect(data.revision).not.toBe(baseline.revision)
  expect(data.page).toMatchObject({ name: '新项目名称', repository: '/repo' })
  const visitor = await browser.newPage({ baseURL })
  await publish(visitor)
  await visitor.goto('/')
  await expect(visitor.getByRole('heading', { name: 'ursi-flow' })).toBeVisible()
  await visitor.close()
  await page.getByRole('button', { name: '还原草稿' }).click()
  await expect(preview.getByRole('heading', { name: 'ursi-flow' })).toBeVisible()
})

test('plugin inventory distinguishes enabled, missing address, and render failure', async ({ page }) => {
  await publish(page)
  await page.route('**/assets/project-links-*.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export function activate({ slots }) {
      slots.register('home.aside', { id: 'broken', Component() { throw new Error('test fault') } })
      slots.register('home.aside', { id: 'working', Component() { return '同槽其他内容' } })
    }`,
  }))
  await page.goto('/manage/#plugins')
  const preview = page.frameLocator('iframe[title="首页草稿预览"]')
  await expect(preview.getByRole('complementary')).toContainText('同槽其他内容')
  await expect(page.getByText('内容渲染失败')).toBeVisible()
  await page.getByRole('switch', { name: '项目链接' }).uncheck()
  await expect(preview.getByRole('complementary')).toHaveCount(0)
  await page.getByRole('combobox', { name: '筛选插件状态' }).selectOption('enabled')
  await page.getByRole('searchbox', { name: '搜索插件' }).fill('unmatched')
  await expect(page.getByText('没有匹配的插件')).toBeVisible()
  await page.getByRole('searchbox', { name: '搜索插件' }).clear()
  await page.getByRole('textbox', { name: 'Workbench 地址' }).clear()
  await expect(preview.getByText('未配置地址')).toBeVisible()
  await expect(page.getByText('未配置', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: '筛选插件状态' }).selectOption('all')
  await page.getByRole('switch', { name: 'Workbench' }).uncheck()
  await expect(preview.getByText('暂无应用入口')).toBeVisible()
})

test('a missing production plugin chunk leaves the home shell and other entry available', async ({ page }) => {
  await publish(page)
  await page.route('**/assets/project-links-*.js', route => route.fulfill({ status: 404, body: 'Not found' }))
  await page.goto('/')
  await expect(page.getByRole('link', { name: /Workbench/ })).toBeVisible()
  await page.getByRole('link', { name: '插件管理' }).click()
  await expect(page.getByText('模块加载失败')).toBeVisible()
  await expect(page.getByText('已加载', { exact: true })).toBeVisible()
})

test('missing and malformed production config fail closed, then publish and rollback replace the shared version', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('插件未启动')
  await expect(page.getByText('暂无应用入口')).toBeVisible()
  await expect(page.getByRole('complementary')).toHaveCount(0)
  let active = { ...baseline, revision: 'bad format' }
  await publish(page, () => active)
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('修订号无效')
  await expect(page.getByRole('link', { name: /Workbench/ })).toHaveCount(0)
  active = baseline
  await page.reload()
  await expect(page.getByRole('link', { name: /Workbench/ })).toBeVisible()
  active = { ...baseline, revision: 'release-b', page: { ...baseline.page, name: '版本 B' }, plugins: { ...baseline.plugins, workbench: false } }
  await page.reload()
  await expect(page.getByRole('heading', { name: '版本 B' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Workbench/ })).toHaveCount(0)
  active = baseline
  await page.reload()
  await expect(page.getByRole('link', { name: /Workbench/ })).toBeVisible()
})

test('homepage and editor are keyboard accessible and fit narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await publish(page)
  await page.goto('/')
  const toggle = page.getByRole('button', { name: '应用导航' })
  const navigation = page.getByRole('navigation', { name: '应用导航' })
  await expect(navigation).toBeHidden()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  await toggle.click()
  await navigation.getByRole('link', { name: /Workbench/ }).focus()
  await page.keyboard.press('Escape')
  await expect(toggle).toBeFocused()
  await page.getByRole('link', { name: '页面管理' }).click()
  await expect(page.getByRole('heading', { name: '页面管理' })).toBeVisible()
  await page.getByRole('button', { name: '窄屏预览' }).click()
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'ursi-flow' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360)
  await page.goto('/manage/#plugins')
  await page.reload()
  await expect(page.getByRole('heading', { name: '插件管理' })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  await expect(page).toHaveURL(/#plugins$/)
})
