import { expect, type Page } from '@playwright/test'

/** 浏览器登录：令牌来自本次运行生成的运行时文件，由测试显式输入。 */
export async function login(page: Page, token: string) {
  await page.goto('/items')
  const field = page.getByLabel('访问令牌')
  await expect(field).toBeVisible()
  await field.fill(token)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '工作清单' })).toBeVisible()
}
