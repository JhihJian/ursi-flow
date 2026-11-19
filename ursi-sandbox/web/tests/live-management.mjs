// Runs against a dedicated Docker Gateway only. Use an already trusted HTTPS certificate.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
const base = new URL(process.env.URSI_TEST_WEB_URL),
  password = (await readFile(process.env.URSI_TEST_ADMIN_FILE, 'utf8')).trim()
const browser = await chromium.launch({
  args: process.env.URSI_TEST_CERT_PIN
    ? [
        `--ignore-certificate-errors-spki-list=${process.env.URSI_TEST_CERT_PIN}`,
      ]
    : [],
})
const page = await browser.newPage({
  httpCredentials: { username: 'admin', password, origin: base.origin },
})
let id
try {
  await page.goto(base.href)
  await page.getByRole('button', { name: '创建沙箱' }).click()
  await page.getByRole('tab', { name: 'JSON 编辑' }).click()
  const name = 'web-smoke-' + Date.now()
  await page
    .getByRole('textbox', { name: 'SandboxSpec JSON' })
    .fill(
      JSON.stringify({
        image: 'alpine:3.22',
        command: ['sleep', '180'],
        labels: { name },
      }),
    )
  await page.getByRole('button', { name: '提交创建' }).click()
  await page.waitForURL(/#\/sandboxes\/[a-f0-9]{32}$/)
  id = page.url().split('/').pop()
  for (const [before, action, after] of [
    ['运行中', '停止', '已停止'],
    ['已停止', '启动', '运行中'],
  ]) {
    await expect(page.locator('.badge')).toHaveText(before, { timeout: 45000 })
    await page.getByRole('button', { name: action, exact: true }).click()
    await expect(page.locator('.badge')).toHaveText(after, { timeout: 45000 })
  }
  await page.getByRole('button', { name: '保留数据重建' }).click()
  await page.getByRole('button', { name: '确认重建' }).click()
  await expect(page.locator('.badge')).toHaveText('运行中', { timeout: 45000 })
  await expect(page.getByText('2 / 1')).toBeVisible()
  await page.getByRole('button', { name: '销毁数据重建' }).click()
  await page.getByRole('button', { name: '确认销毁并重建' }).click()
  await expect(page.locator('.badge')).toHaveText('运行中', { timeout: 45000 })
  await expect(page.getByText('3 / 3')).toBeVisible()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '确认永久删除' }).click()
  await page.waitForURL(/#\/sandboxes$/, { timeout: 45000 })
  const status = await page.evaluate(
    async (id) => (await fetch('./api/v1/sandboxes/' + id)).status,
    id,
  )
  assert.equal(status, 404)
  id = null
  console.log(
    'Docker Gateway verified: create, running, stop, stopped, start, running, cancel deletion, delete, 404',
  )
} finally {
  if (id)
    await page
      .evaluate(
        (id) =>
          fetch('./api/v1/sandboxes/' + id, {
            method: 'DELETE',
            headers: { 'X-Ursi-Action': 'manage' },
          }),
        id,
      )
      .catch(() => {})
  await browser.close()
}
