import { expect, test } from '@playwright/test'

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
const withDocs = `---
name: 文档视图验收
description: 含引用文档与 Mermaid 图的流程。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> sum[汇总结果]
  sum -->|已完成| finish((结束))
\`\`\`

## 汇总结果

\`\`\`新建Agent
根据 [检查清单](references/checklist.md) 汇总结果：{var.任务}
\`\`\`

### 已完成

已按清单汇总。
`

async function openNewFlow(page) {
  await page.goto('/')
  await page.getByRole('link', { name: '创建 Flow', exact: true }).click()
  await expect(page.getByRole('heading', { name: '创建 Flow' })).toBeVisible()
}
// 点中连线本体：取路径上的实际点，避免点到外框中心外的空白。
async function clickEdge(page, result) {
  const point = await page.evaluate((text) => {
    for (const edge of document.querySelectorAll('.react-flow__edge')) {
      const label = edge.dataset.id?.split('|')[1]
      if (label !== text) continue
      const path = edge.querySelector('.cedge-path')
      const at = path.getPointAtLength(path.getTotalLength() / 2)
      const matrix = path.getScreenCTM()
      return { x: matrix.a * at.x + matrix.c * at.y + matrix.e, y: matrix.b * at.x + matrix.d * at.y + matrix.f }
    }
    return null
  }, result)
  if (!point) throw Error(`找不到结果边 ${result}`)
  await page.mouse.click(point.x, point.y)
}

async function fillFiles(page, id, source) {
  await page.getByLabel('Flow 标识').fill(id)
  await page.getByRole('tab', { name: '源码' }).click()
  await page.getByLabel('FLOW.md 内容').fill(source)
  await page.getByRole('button', { name: '校验' }).click()
  await expect(page.getByRole('status').filter({ hasText: '校验通过' })).toBeVisible()
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存修订' })).toBeVisible()
}

test('图形视图可按画布编辑节点与结果边，并跑通运行闭环', async ({ page }) => {
  await openNewFlow(page)
  await fillFiles(page, 'e2e-graph', quick)

  // 图形视图把 FLOW.md 画成节点卡片和结果边。
  await page.getByRole('tab', { name: '图形' }).click()
  await expect(page.locator('.cnode')).toHaveCount(1)
  await expect(page.locator('.cterminal')).toHaveCount(2)
  // 选中连线的结果说明只在选中时显示在走线上。
  await clickEdge(page, '已执行')
  await expect(page.locator('.cedge-label').filter({ hasText: '已执行' })).toBeVisible()
  await expect(page.locator('.canvas-inspector')).toContainText('已执行')

  // 选中节点后改名，文本与画布同步。
  await page.locator('.cnode').click()
  await page.getByLabel('节点名称').fill('执行验收检查')
  await expect(page.locator('.cnode-title')).toHaveText('执行验收检查')
  await expect(page.getByRole('status').filter({ hasText: '校验' })).toHaveCount(0)

  // 新增节点只是孤立节点，画布提示后接到开始与结束，结构恢复可用。
  await page.getByRole('button', { name: '新建Agent', exact: true }).click()
  await expect(page.locator('.cnode')).toHaveCount(2)
  await expect(page.locator('.canvas-issues')).toContainText('新节点')
  // 命令节点只有一条已执行出边，把它改连到新节点，再由新节点连到结束。
  await page.getByRole('button', { name: '结果', exact: true }).click()
  await page.locator('.cnode', { hasText: '执行验收检查' }).click()
  await page.getByLabel('目标节点').selectOption({ label: '新节点' })
  await expect(page.locator('.canvas-issues')).toHaveCount(0)

  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存修订' })).toBeVisible()

  // 源码视图同步反映改名结果，新增结果小节带有占位说明。
  await page.getByRole('tab', { name: '源码' }).click()
  await expect(page.getByLabel('FLOW.md 内容')).toHaveValue(/check\[执行验收检查\]/)
  await expect(page.getByLabel('FLOW.md 内容')).toHaveValue(/check -->\|已执行\| step1\[新节点\]/)
  await expect(page.getByLabel('FLOW.md 内容')).toHaveValue(/## 新节点/)
  // 新结果小节自带占位说明，符合规范要求。
  await expect(page.getByLabel('FLOW.md 内容')).toHaveValue(/### 已执行\n\n节点返回“已执行”时继续执行。/)

  await page.getByLabel('Run ID（可选）').fill('e2e-graph-run')
  await page.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-graph-run$/)
})

test('文档视图渲染 Markdown、Mermaid 图与包内链接', async ({ page }) => {
  await openNewFlow(page)
  // FLOW.md 引用了 references/checklist.md，先建好引用文件再校验。
  await page.getByLabel('新增文件路径').fill('references/version.md')
  await page.getByRole('button', { name: '新增文件' }).click()
  await page.getByLabel('Markdown 源码').fill('# 版本规范\n\n版本号必须与 FLOW.md 声明一致。\n')
  await page.getByLabel('新增文件路径').fill('references/checklist.md')
  await page.getByRole('button', { name: '新增文件' }).click()
  await page.getByLabel('Markdown 源码').fill(
    '# 检查清单\n\n- 版本号一致\n- 说明完整\n\n规则见 [版本规范](version.md)。\n',
  )
  await expect(page.locator('.md h1')).toHaveText('检查清单')
  await expect(page.locator('.md li')).toHaveCount(2)

  await page.getByRole('button', { name: 'FLOW.md' }).click()
  await fillFiles(page, 'e2e-doc', withDocs)

  // Mermaid 代码块被画成图，而不是继续显示源码。
  await page.getByRole('tab', { name: '文档' }).click()
  await expect(page.locator('.mermaid-figure svg')).toHaveCount(1)
  await expect(page.locator('code.language-mermaid')).toHaveCount(0)
  await expect(page.locator('.md h2').first()).toHaveText('汇总结果')

  // 包内相对链接直接打开对应文件。
  await page.getByRole('button', { name: 'references/checklist.md' }).click()
  await page.locator('.md a', { hasText: '版本规范' }).click()
  await expect(page.getByLabel('Markdown 源码')).toHaveValue(/版本号必须与/)
  await expect(page.locator('.md h1')).toHaveText('版本规范')
})

test('目录修订过期时保存返回冲突并保留草稿', async ({ page }) => {
  await openNewFlow(page)
  await fillFiles(page, 'e2e-conflict', quick)
  const created = await page.evaluate(async (files) => {
    const response = await fetch('/api/v1/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-other', files }),
    })
    return response.status
  }, { 'FLOW.md': quick })
  expect(created).toBe(200)
  await page.getByRole('tab', { name: '源码' }).click()
  await page.getByLabel('FLOW.md 内容').fill(quick + '\n<!-- 追加说明 -->\n')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('alert').first()).toContainText('冲突')
  await expect(page.getByLabel('FLOW.md 内容')).toHaveValue(/追加说明/)
})

test('停止运行与运行配置', async ({ page }) => {
  await openNewFlow(page)
  await fillFiles(page, 'e2e-slow', slow)
  await page.getByLabel('Run ID（可选）').fill('e2e-slow-run')
  await page.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-slow-run$/)
  await expect(page.locator('.heading .badge.running')).toBeVisible()
  await page.getByRole('button', { name: '停止运行' }).click()
  await page.getByRole('button', { name: '确认停止' }).click()
  await expect(page.locator('.heading .badge.stopped')).toBeVisible({ timeout: 15000 })

  await page.getByLabel('主导航').getByRole('link', { name: '运行配置' }).click()
  await page.getByLabel('最大并发数').fill('2')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible()
})
