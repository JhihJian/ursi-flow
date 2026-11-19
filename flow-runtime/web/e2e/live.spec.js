import { expect, test } from '@playwright/test'

const token = 'e2e-console-token'
const quick = `---
name: 控制台验收
description: 控制台端到端验收使用的命令节点流程。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> check[执行检查]
  check -->|已执行| finish((结束))
\`\`\`

## 执行检查

\`\`\`执行自定义命令
{
  "command": "node",
  "args": ["-e", "console.log('检查通过')"]
}
\`\`\`

### 已执行

命令已执行，控制台应显示标准输出证据。
`
const slow = `---
name: 停止验收
description: 用于验证控制台停止长期运行的命令节点。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> wait[等待结束]
  wait -->|已执行| finish((结束))
\`\`\`

## 等待结束

\`\`\`执行自定义命令
{
  "command": "node",
  "args": ["-e", "setTimeout(() => 0, 60000)"]
}
\`\`\`

### 已执行

长时间运行的命令便于验证停止操作。
`

async function login(page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '连接 Runtime' })).toBeVisible()
  await page.getByLabel('访问令牌').fill(token)
  await page.getByRole('button', { name: '连接' }).click()
  await expect(page.getByRole('heading', { name: 'Flow 包' })).toBeVisible()
}

async function createFlow(page, id, source) {
  await page.getByRole('link', { name: '创建 Flow', exact: true }).click()
  await page.getByLabel('Flow 标识').fill(id)
  await page.getByLabel('FLOW.md 内容').fill(source)
  await page.getByRole('button', { name: '校验' }).click()
  await expect(page.getByRole('status').filter({ hasText: '校验通过' })).toBeVisible()
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存修订' })).toBeVisible()
}

test('未认证时要求令牌，认证后完成建包、校验、运行、停止与配置闭环', async ({
  page,
}) => {
  await login(page)
  await createFlow(page, 'e2e-check', quick)

  await page.getByLabel('Run ID（可选）').fill('e2e-run-1')
  await page.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-run-1$/)
  await expect(page.locator('.heading .badge.completed')).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: '执行证据' }).click()
  await expect(page.locator('pre').filter({ hasText: '检查通过' }).first()).toBeVisible()
  await expect(page.locator('table').filter({ hasText: '结束' })).toBeVisible()

  await page.getByLabel('主导航').getByRole('link', { name: '运行记录' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.getByLabel('主导航').getByRole('link', { name: 'Flow 包' }).click()
  await createFlow(page, 'e2e-slow', slow)
  await page.getByLabel('Run ID（可选）').fill('e2e-run-2')
  await page.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-run-2$/)
  await expect(page.locator('.heading .badge.running')).toBeVisible()
  await page.getByRole('button', { name: '停止运行' }).click()
  await page.getByRole('button', { name: '确认停止' }).click()
  await expect(page.locator('.heading .badge.stopped')).toBeVisible({ timeout: 15000 })

  await page.getByLabel('主导航').getByRole('link', { name: '运行配置' }).click()
  await page.getByLabel('最大并发数').fill('2')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible()
})

test('目录修订过期时保存返回冲突并保留草稿', async ({ page }) => {
  await login(page)
  await createFlow(page, 'e2e-conflict', quick)
  // 另一个包的发布会让整个目录修订前进，手上的编辑页随即过期。
  const created = await page.evaluate(
    async ({ token, files }) => {
      const response = await fetch('/api/v1/flows', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'e2e-other', files }),
      })
      return response.status
    },
    { token, files: { 'FLOW.md': quick } },
  )
  expect(created).toBe(200)
  await page.getByLabel('FLOW.md 内容').fill(quick + '\n<!-- 追加说明 -->\n')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('alert').first()).toContainText('冲突')
  await expect(page.getByLabel('FLOW.md 内容')).toHaveValue(/追加说明/)
})
