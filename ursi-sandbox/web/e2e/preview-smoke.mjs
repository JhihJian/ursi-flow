// 预览冒烟：node e2e/preview-smoke.mjs（需 preview-server 已运行）
import { chromium } from '@playwright/test'

const base = 'http://127.0.0.1:14482/dist/'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})
try {
  await page.goto(base)
  await page.getByRole('link', { name: '查看 web-demo' }).waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: '创建沙箱' }).click()
  await page.getByRole('dialog').waitFor()
  await page.keyboard.press('Escape')
  await page.goto(base + '#/sandboxes/' + '1'.repeat(32))
  await page.getByRole('region', { name: '端点工作台' }).waitFor()
  await page.goto(base + '#/registry')
  await page.getByRole('heading', { name: '能力注册表' }).waitFor({ timeout: 10000 })
  await page.goto(base + '#/access')
  await page.getByText('default').first().waitFor({ timeout: 10000 })
  console.log(errors.length ? '有报错:\n' + errors.join('\n') : '页面全部渲染无报错')
} finally {
  await browser.close()
}
