import { expect, test } from '@playwright/test'

test('局域网直接打开 Agent 工作区，浏览器不发送令牌', async ({ page, baseURL }) => {
  const executorRef = { id: 'pi-default', revision: 1 }
  const revision = { ...executorRef, agent: { configPackageId: 'cfg', backendId: 'pi' } }
  await page.route('**/api/v2/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    expect(url.origin).toBe(baseURL)
    expect(request.headers().authorization).toBeUndefined()
    expect(request.headers()['x-ursi-lan-preview']).toBe('1')
    if (url.pathname === '/api/v2/executors') return route.fulfill({ json: [{ ...revision, active: true }] })
    if (url.pathname === '/api/v2/executors/pi-default/revisions') return route.fulfill({ json: [revision] })
    const match = /^\/api\/v2\/executor-attempts\/([a-f0-9-]{36})(\/events)?$/.exec(url.pathname)
    if (!match) throw new Error(`意外请求：${url.pathname}`)
    if (match[2]) return route.fulfill({ json: { events: [], nextCursor: 0 } })
    expect(request.method()).toBe('PUT')
    expect(request.postDataJSON()).toEqual({ executorRef, workInstruction: { encoding: 'utf-8', text: '核对材料' } })
    return route.fulfill({ json: { attemptId: match[1], status: 'succeeded' } })
  })
  await page.goto('/agent')
  await expect(page.getByRole('heading', { name: 'Agent 工作区' })).toBeVisible()
  await expect(page.getByLabel('访问令牌')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '退出登录' })).toHaveCount(0)
  await expect(page.getByRole('option', { name: /pi-default/ })).toHaveCount(1)
  await page.getByLabel('任务指令').fill('核对材料')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('已完成', { exact: true })).toBeVisible()
})
