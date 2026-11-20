import { test, expect } from '@playwright/test'

test('纯静态子目录：主题、列表、详情和刷新', async ({ page }) => {
  const base = 'http://127.0.0.1:14482/dist/'
  const paths = [],
    sockets = []
  page.on('request', (r) => paths.push(r.url()))
  page.on('websocket', (ws) => sockets.push(ws.url()))
  await page.addInitScript(() => {
    localStorage.setItem('ursi-flow:theme', 'dark')
    localStorage.setItem('ursi-flow:palette', 'mono')
  })
  await page.goto(base)
  await expect(page.locator('html')).toHaveCSS(
    'background-color',
    'rgb(9, 9, 9)',
  )
  await page.getByRole('link', { name: '查看 hello-html' }).click()
  await expect(page).toHaveURL(/\/dist\/#\/sandboxes\/[a-f0-9]{32}$/)
  await page.reload()
  await page.getByRole('button', { name: '实例日志' }).click()
  await expect(page.getByLabel('实例日志输出')).toContainText(
    '[status] running',
  )
  const tools = page.getByRole('region', { name: '端点工作台' })
  await tools.getByRole('button', { name: '打开终端示例' }).click()
  await expect(
    tools.getByLabel('终端输出').locator('.xterm-rows'),
  ).toContainText('README.md  index.html')
  for (const name of ['IDE', '桌面', '应用预览']) {
    await tools.getByRole('tab', { name, exact: true }).click()
    await expect(tools.getByRole('status')).toHaveText('演示数据')
    await expect(
      tools.getByRole('button', { name: '连接', exact: true }),
    ).toHaveCount(0)
  }
  expect(sockets).toEqual([])
  expect(paths.some((url) => url.includes('/api/'))).toBe(false)
  await page.getByRole('link', { name: '实例列表' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(6)
  expect(paths.every((url) => url.startsWith(base))).toBe(true)
})
