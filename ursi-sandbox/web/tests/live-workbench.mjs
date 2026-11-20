// Against a dedicated live Gateway and browser bundle. An optional ready HTTP
// endpoint exercises app preview in the same sandbox as the IDE and desktop.
import { readFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const base = new URL(process.env.URSI_TEST_WEB_URL)
const id = process.env.URSI_TEST_SANDBOX_ID
const password = (await readFile(process.env.URSI_TEST_ADMIN_FILE, 'utf8')).trim()
const browser = await chromium.launch({
  args: process.env.URSI_TEST_CERT_PIN ? [`--ignore-certificate-errors-spki-list=${process.env.URSI_TEST_CERT_PIN}`] : [],
})
try {
  const page = await browser.newPage({
    httpCredentials: { username: 'admin', password, origin: base.origin },
  })
  await page.goto(new URL(`./#/sandboxes/${id}`, base).href)
  const panel = page.getByRole('region', { name: '端点工作台' })
  const connect = async () => {
    await panel.getByRole('button', { name: '连接', exact: true }).click()
    await expect(panel.getByRole('status').first()).toHaveText('已连接', { timeout: 15000 })
  }
  await connect()
  await page.keyboard.type("printf '%s%s\\n' 'WEB_PTY_' 'OK'")
  await page.keyboard.press('Enter')
  await expect(panel.locator('.xterm-rows')).toContainText('WEB_PTY_OK', { timeout: 5000 })
  const app = process.env.URSI_TEST_APP_ENDPOINT
  for (const view of ['桌面', 'IDE', ...(app ? ['应用预览'] : [])]) {
    await panel.getByRole('button', { name: view, exact: true }).click()
    if (view === '应用预览') await panel.getByRole('combobox').selectOption(app)
    await connect()
    const canvas = panel.locator('canvas')
    await expect(canvas).toBeVisible()
    await expect.poll(() => canvas.evaluate((el) => {
      if (el.width < 2 || el.height < 2) return false
      const data = el.getContext('2d').getImageData(0, 0, el.width, el.height).data
      for (let i = 0; i < data.length; i += 4) if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) return true
      return false
    }), { timeout: 10000 }).toBe(true)
    const control = panel.getByRole('checkbox', { name: '键鼠控制' })
    if (view === 'IDE') await expect(control).toBeChecked()
    else await expect(control).not.toBeChecked()
  }
  await panel.getByRole('button', { name: '断开', exact: true }).click()
  await expect(panel.locator('canvas')).toHaveCount(0)
  console.log('Live workbench passed: terminal, desktop, IDE' + (app ? ', app preview' : ''))
} finally {
  await browser.close()
}
