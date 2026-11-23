import { test, expect } from '@playwright/test'

const key = {
  key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIACiTCENvMi768W+epq2eiN++GZs+YTo/kGT/R0YQeNM ops@laptop',
  fingerprint: 'SHA256:RlLhuhpYsO+pHD1wCItOrArG/eQQpazA/8N3ippsNw',
  created_at: 1_700_000_000,
}
const sandbox = {
  id: 'a1d81fee7e1b40f9b8e140235f2cf01a',
  status: 'running',
  generation: 1,
  attached: true,
}
const report = {
  profiles: [
    { profile: 'browser', rendered_at: 1_700_000_100, keys: [key], sandboxes: [sandbox] },
  ],
}

async function admin(page, capabilities = { access_keys: true }) {
  await page.route('**/console-config.json', (r) =>
    r.fulfill({ json: { mode: 'gateway', manage: true } }),
  )
  await page.route('**/api/v1/capabilities', (r) =>
    r.fulfill({ json: { tunnel_enabled: false, capabilities } }),
  )
  await page.route('**/api/v1/sandboxes', (r) => r.fulfill({ json: { sandboxes: [] } }))
}

for (const width of [320, 1280]) {
  test(`接入配置展示安装步骤与状态 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await admin(page)
    await page.route('**/api/v1/access-keys', (r) => r.fulfill({ json: report }))

    await page.goto('./#/access')
    await expect(page.getByRole('heading', { name: '接入配置' })).toBeVisible()
    await expect(page.getByText('ssh-keygen -t ed25519')).toBeVisible()
    await expect(
      page.getByText('ursi-sandbox-client ssh-config >> ~/.ssh/config'),
    ).toBeVisible()
    // 公钥作用域在页面上必须写清是 profile 级，不是单实例。
    await expect(
      page.getByText('公钥对该 Runtime Profile 下的所有沙箱生效，不是单实例授权。'),
    ).toBeVisible()
    await expect(page.getByText(key.fingerprint)).toBeVisible()
    await expect(page.getByText('已挂载授权文件')).toBeVisible()
    // 只有一个公钥时不允许撤销到空集合。
    await expect(page.getByRole('button', { name: '撤销' })).toBeDisabled()
  })
}

test('没有接入权限的只读身份看不到入口', async ({ page }) => {
  await page.route('**/console-config.json', (r) =>
    r.fulfill({ json: { mode: 'gateway', manage: false } }),
  )
  await page.route('**/api/v1/capabilities', (r) =>
    r.fulfill({ json: { tunnel_enabled: false, capabilities: {} } }),
  )
  await page.route('**/api/v1/sandboxes', (r) => r.fulfill({ json: { sandboxes: [] } }))
  await page.goto('./#/sandboxes')
  await expect(page.getByRole('link', { name: '接入配置' })).toHaveCount(0)
})

test('Gateway 未启用授权公钥时给出明确原因', async ({ page }) => {
  await admin(page, { access_keys: false })
  await page.route('**/api/v1/access-keys', (r) =>
    r.fulfill({ status: 501, json: { error: { message: 'unsupported' } } }),
  )
  await page.goto('./#/access')
  await expect(page.getByText('当前 Gateway 未启用 SSH 授权公钥管理')).toBeVisible()
})

test('登记公钥提交 profile 与公钥并刷新状态', async ({ page }) => {
  let body
  await admin(page)
  await page.route('**/api/v1/access-keys', async (r) => {
    if (r.request().method() === 'POST') {
      body = r.request().postDataJSON()
      return r.fulfill({ status: 201, json: report })
    }
    return r.fulfill({ json: { profiles: [] } })
  })
  await page.goto('./#/access')
  await page.getByLabel('Runtime Profile').fill('browser')
  await page.getByLabel('公钥（id_ed25519.pub 的内容）').fill(key.key)
  await page.getByRole('button', { name: '登记公钥' }).click()
  await expect(page.getByText(key.fingerprint)).toBeVisible()
  expect(body).toEqual({ profile: 'browser', key: key.key })
})

test('撤销公钥通过 DELETE 携带 profile 与指纹', async ({ page }) => {
  let method, body
  // 至少两条公钥时才允许撤销，避免把 profile 删成空集合。
  const second = { ...key, fingerprint: 'SHA256:secondkeysecondkeysecondkeysecondkeysecond' }
  await admin(page)
  await page.route('**/api/v1/access-keys', async (r) => {
    if (r.request().method() === 'DELETE') {
      method = 'DELETE'
      body = r.request().postDataJSON()
      return r.fulfill({ json: { profiles: [] } })
    }
    return r.fulfill({
      json: {
        profiles: [
          { profile: 'browser', rendered_at: 1_700_000_100, keys: [key, second], sandboxes: [sandbox] },
        ],
      },
    })
  })
  await page.goto('./#/access')
  await expect(page.getByText(key.fingerprint)).toBeVisible()
  const button = page.getByRole('button', { name: '撤销' }).first()
  await expect(button).toBeEnabled()
  await button.click({ force: true })
  await expect.poll(() => method).toBe('DELETE')
  expect(body).toEqual({ profile: 'browser', fingerprint: key.fingerprint })
})
