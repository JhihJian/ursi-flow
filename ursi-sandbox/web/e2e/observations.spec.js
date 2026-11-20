import { test, expect } from '@playwright/test'

const id = '1'.repeat(32),
  run = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
  path = `sandboxes/${id}/observations/${run}`
async function configure(page, manage) {
  await page.route('**/console-config.json', (r) =>
    r.fulfill({ json: { mode: 'gateway', manage } }),
  )
  await page.route('**/api/v1/capabilities', (r) =>
    r.fulfill({ json: { capabilities: {}, observer_enabled: true } }),
  )
}
test('深链不依赖实例，离线保留快照，恢复后仅允许读取中断分段', async ({
  page,
}) => {
  await configure(page, true)
  await page.setViewportSize({ width: 375, height: 740 })
  let status = 200,
    interrupted = false,
    segmentReads = 0
  await page.route('**/api/v1/' + path, (r) =>
    r.fulfill({
      status,
      json: {
        sandbox_id: id,
        observation_id: run,
        generation: 2,
        started_ms: 12345678,
        ended_ms: null,
        state: interrupted ? 'interrupted' : 'degraded',
        segments: 1,
        packets: 93,
        bytes: 20170,
        kernel_drops: 3,
        queue_drops: 0,
      },
    }),
  )
  await page.route('**/segments/1', (r) => {
    segmentReads++
    return r.fulfill({ status: 403, json: {} })
  })
  await page.goto('./#/' + path)
  await expect(page.getByText('丢包或截断', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '下载完整分段' })).toHaveCount(0)
  status = 503
  await expect(page.getByText('状态未知', { exact: true })).toBeVisible()
  await expect(page.getByText('93', { exact: true })).toBeVisible()
  status = 200
  interrupted = true
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByText('异常中断', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '下载完整分段' })).toBeVisible()
  expect(segmentReads).toBe(0)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375)
  await page.getByRole('button', { name: '预览分段' }).click()
  await expect(page.getByText('无权读取观测记录')).toBeVisible()
  await expect(page.getByText('93', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '下载完整分段' })).toHaveCount(0)
})
test('只读身份直接打开深链不会读取观测', async ({ page }) => {
  await configure(page, false)
  let reads = 0
  await page.route('**/api/v1/' + path, (r) => {
    reads++
    return r.abort()
  })
  await page.goto('./#/' + path)
  await expect(page.getByRole('alert')).toHaveText('需要管理员身份')
  expect(reads).toBe(0)
})
