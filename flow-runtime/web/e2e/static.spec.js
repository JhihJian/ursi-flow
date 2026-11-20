import { expect, test } from '@playwright/test'

test('静态子目录未配置后端时显示错误，不加载内置 Flow', async ({ page }) => {
  const paths = []
  page.on('request', (request) => paths.push(new URL(request.url()).pathname))
  await page.addInitScript(() => {
    localStorage.setItem('ursi-flow:theme', 'dark')
    localStorage.setItem('ursi-flow:palette', 'mono')
  })
  await page.goto('http://127.0.0.1:14484/dist/#/flows/ordinary/edit')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(9, 9, 9)')
  await expect(page.getByText(/无法读取控制台配置/)).toBeVisible()
  await expect(page.getByRole('tab', { name: '总览' })).toHaveCount(0)
  expect(paths).toContain('/dist/console-config.json')
  expect(paths.some((path) => path.startsWith('/api/'))).toBe(false)
})
