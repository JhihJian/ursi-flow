import { test, expect, expectNoOverflow, navigate } from './fixtures'

test.describe('对话模块', () => {
  test.setTimeout(60_000)

  test('新建会话、流式回复、刷新保留与响应式布局', async ({ page }) => {
    await page.goto('/workflows')
    await navigate(page, '对话')
    await expect(page).toHaveURL(/\/chat$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('对话')
    await expect(page).toHaveTitle('对话 · ursi-flow')
    await expect(page.getByRole('heading', { name: '开始一段新对话' })).toBeVisible()
    await expectNoOverflow(page)

    await page.getByRole('button', { name: '新建对话' }).click()
    await expect(page).toHaveURL(/\/chat\/chat-\d+$/)
    const input = page.getByLabel('输入消息')
    await expect(input).toBeEnabled()
    await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()

    await input.fill('现在有哪些工作流和运行？')
    await input.press('Enter')
    const log = page.getByRole('list', { name: '消息记录' })
    await expect(log.getByText('现在有哪些工作流和运行？', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '停止' })).toBeVisible()
    await expectNoOverflow(page)

    // 演示回复按 6–12 段真实延时推送，结束后按钮回到发送状态。
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 20_000 })
    await expect(log.getByText('本地演示回复，未调用模型', { exact: false })).toBeVisible()
    await expect(log.getByText('工具调用 · 读取运行记录', { exact: false })).toBeVisible()
    await expectNoOverflow(page)

    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('对话')
    await expect(page.getByRole('list', { name: '消息记录' }).getByText('本地演示回复，未调用模型', { exact: false })).toBeVisible()
    await expect(page.getByLabel('输入消息')).toBeEnabled()
    await expectNoOverflow(page)
  })
})
