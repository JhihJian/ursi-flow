import { expect, test } from '@playwright/test'
import { workspaces } from './global-setup.mjs'

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
const withVars = `---
name: 启动参数验收
description: 验证控制台按 FLOW.md 生成启动参数表单。
variables:
  任务:
    description: 本次检查目标
  修改记录:
    description: 过程中写入的记录
    default: 尚未修改
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
  "args": ["-e", "console.log('检查通过')"],
  "stdin": "检查目标：{var.任务}"
}
\`\`\`

### 已执行

命令已执行，记录写入 variables.修改记录。
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

// 直接调用同源接口播种包内容：源码视图已移除，包内容用接口准备最直观。
async function api(page, path, method = 'GET', body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch('/api/v1' + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    },
    { path, method, body },
  )
}
async function seed(page, id, files) {
  await page.goto('/')
  const result = await api(page, '/flows', 'POST', { id, files })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return result.body
}
async function openFlow(page, id) {
  await page.goto('/#/flows/' + id + '/edit')
  await expect(page.getByRole('heading', { name: id, exact: true })).toBeVisible()
  await expect(page.locator('.cnode').first()).toBeVisible()
}
async function storedFlow(page, id) {
  const result = await api(page, '/flows/' + id)
  expect(result.status).toBe(200)
  return result.body
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

test('从空包开始用图形与脚本编辑，保存后可以运行', async ({ page }) => {
  await openNewFlow(page)
  await page.getByLabel('Flow 标识').fill('e2e-create')

  // 模板只有一个工作节点，改名后改动作、再加脚本文件。
  await page.locator('.cnode').click()
  await page.getByLabel('节点名称').fill('跑脚本')
  await page.getByLabel('动作').selectOption({ label: '执行自定义命令' })
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('节点内容').fill(
    '{\n  "command": "node",\n  "args": ["scripts/hello.mjs"]\n}',
  )
  await page.getByRole('button', { name: '收起' }).click()

  // scripts 下的文件用脚本视图编辑，不提供图形与文档。
  await page.getByLabel('新增文件路径').fill('scripts/hello.mjs')
  await page.getByRole('button', { name: '新增文件' }).click()
  await expect(page.getByLabel('scripts/hello.mjs 内容')).toBeVisible()
  await expect(page.getByRole('tab', { name: '图形' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '文档' })).toHaveCount(0)
  await page.getByLabel('scripts/hello.mjs 内容').fill("console.log('hello from script')\n")

  await page.getByRole('button', { name: '校验' }).click()
  await expect(page.getByRole('status').filter({ hasText: '校验通过' })).toBeVisible()
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存修订' })).toBeVisible()

  const created = await storedFlow(page, 'e2e-create')
  expect(created.files['scripts/hello.mjs']).toContain('hello from script')
  expect(created.files['FLOW.md']).toMatch(/## 跑脚本/)

  // 直接切换包也要刷新内容（修订号是整个目录共用的，只看修订会误判成同一份）。
  await seed(page, 'e2e-switch', { 'FLOW.md': quick })
  await page.goto('/#/flows/e2e-switch/edit')
  await expect(page.getByRole('heading', { name: 'e2e-switch', exact: true })).toBeVisible()
  await expect(page.locator('.cnode')).toHaveCount(1)

  // 回到 FLOW.md 只看得到图形与文档两个视图。
  await page.getByRole('button', { name: 'FLOW.md' }).click()
  await expect(page.getByRole('tab', { name: '图形' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '文档' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '源码' })).toHaveCount(0)
})

test('图形视图可按画布编辑节点与结果边，并跑通运行闭环', async ({ page }) => {
  await seed(page, 'e2e-graph', { 'FLOW.md': quick })
  await openFlow(page, 'e2e-graph')

  // 打开 FLOW.md 默认就是图形视图。
  await expect(page.getByRole('tab', { name: '图形' })).toHaveAttribute('aria-selected', 'true')
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

  // 保存后的 FLOW.md 反映改名与新增节点，新结果小节自带占位说明。
  const saved = (await storedFlow(page, 'e2e-graph')).files['FLOW.md']
  expect(saved).toMatch(/check\[执行验收检查\]/)
  expect(saved).toMatch(/check -->\|已执行\| step1\[新节点\]/)
  expect(saved).toMatch(/step1 -->\|已执行\| finish/)
  expect(saved).toMatch(/## 新节点/)
  expect(saved).toMatch(/### 已执行\s+节点返回“已执行”时继续执行。/)

  await page.getByRole('button', { name: '启动运行' }).click()
  const startDialog = page.getByRole('dialog')
  await startDialog.getByLabel('Run ID（可选）').fill('e2e-graph-run')
  await startDialog.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-graph-run$/)
})

test('启动参数按 FLOW.md 全局变量生成表单，过程变量不进表单', async ({ page }) => {
  await seed(page, 'e2e-params', { 'FLOW.md': withVars })
  await openFlow(page, 'e2e-params')
  await page.getByRole('button', { name: '启动运行' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('1 项启动变量，1 项必填')
  // 只有声明的全局变量进表单；过程中由节点写入的变量只作说明。
  await expect(dialog.locator('#start-var-任务')).toBeVisible()
  await expect(dialog).not.toContainText('提示词未引用')
  await expect(dialog.locator('#start-var-修改记录')).toHaveCount(0)
  await expect(dialog).toContainText('过程中由节点写入')
  await dialog.getByLabel('Run ID（可选）').fill('e2e-params-run')

  // 必填项留空时不发起运行。
  await dialog.getByRole('button', { name: '启动运行' }).click()
  await expect(dialog).toContainText('请补齐标记为必填的变量')
  await dialog.locator('#start-var-任务').fill('验收任务')
  await dialog.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-params-run$/)
  // 提交的变量只有必填项，过程变量连同默认值由 Runtime 自己管理。
  const run = await api(page, '/runs/e2e-params-run')
  expect(run.body.variables).toEqual({ 任务: '验收任务' })

  // 高级入口接受原始 JSON，未声明的名字直接拒绝。
  await page.goto('/#/flows/e2e-params/edit')
  await page.getByRole('button', { name: '启动运行' }).click()
  await dialog.getByRole('button', { name: '高级：编辑 JSON' }).click()
  await dialog.locator('#start-run-json').fill('{"任务":"高级任务","未知":1}')
  await dialog.getByRole('button', { name: '启动运行' }).click()
  await expect(dialog).toContainText('未声明的启动变量：未知')
  await dialog.locator('#start-run-json').fill('{"任务":"高级任务"}')
  await dialog.getByLabel('Run ID（可选）').fill('e2e-params-advanced')
  await dialog.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-params-advanced$/)
  const advanced = await api(page, '/runs/e2e-params-advanced')
  expect(advanced.body.variables).toEqual({ 任务: '高级任务' })
})

test('未指定工作目录时在工作区根目录下按 Run ID 新建', async ({ page }) => {
  await seed(page, 'e2e-cwd', { 'FLOW.md': quick })
  await openFlow(page, 'e2e-cwd')
  await page.getByRole('button', { name: '启动运行' }).click()
  const dialog = page.getByRole('dialog')
  // 工作目录留空即可，对话框说明会落在哪里。
  await expect(dialog).toContainText(`${workspaces}`)
  await expect(dialog.getByLabel('工作目录（可选）')).toHaveAttribute(
    'placeholder',
    `${workspaces}/<Run ID>`,
  )
  await dialog.getByLabel('Run ID（可选）').fill('e2e-cwd-auto')
  await dialog.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-cwd-auto$/)

  const auto = await api(page, '/runs/e2e-cwd-auto')
  expect(auto.body.cwd).toBe(`${workspaces}/e2e-cwd-auto`)
  await expect
    .poll(async () => (await api(page, '/runs/e2e-cwd-auto')).body.status)
    .toBe('completed')

  // 显式目录优先于工作区根目录。
  await page.goto('/#/flows/e2e-cwd/edit')
  await page.getByRole('button', { name: '启动运行' }).click()
  await dialog.getByLabel('Run ID（可选）').fill('e2e-cwd-explicit')
  await dialog.getByLabel('工作目录（可选）').fill(process.cwd())
  await dialog.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-cwd-explicit$/)
  const explicit = await api(page, '/runs/e2e-cwd-explicit')
  expect(explicit.body.cwd).toBe(process.cwd())

  // 目录不存在时对话框留在原地报错。
  await page.goto('/#/flows/e2e-cwd/edit')
  await page.getByRole('button', { name: '启动运行' }).click()
  await dialog.getByLabel('Run ID（可选）').fill('e2e-cwd-missing')
  await dialog.getByLabel('工作目录（可选）').fill('/nonexistent-e2e-dir')
  await dialog.getByRole('button', { name: '启动运行' }).click()
  await expect(dialog).toContainText('工作目录不可用')
})

test('文档视图渲染 Markdown、Mermaid 图与包内链接', async ({ page }) => {
  await seed(page, 'e2e-doc', {
    'FLOW.md': withDocs,
    'references/version.md': '# 版本规范\n\n版本号必须与 FLOW.md 声明一致。\n',
    'references/checklist.md':
      '# 检查清单\n\n- 版本号一致\n- 说明完整\n\n规则见 [版本规范](version.md)。\n',
  })
  await openFlow(page, 'e2e-doc')

  // 引用文档默认打开文档视图。
  await page.getByRole('button', { name: 'references/checklist.md' }).click()
  await expect(page.locator('.md h1')).toHaveText('检查清单')
  await expect(page.locator('.md li')).toHaveCount(2)

  await page.getByRole('button', { name: 'FLOW.md' }).click()
  await page.getByRole('tab', { name: '文档' }).click()
  await expect(page.locator('.mermaid-figure svg')).toHaveCount(1)
  await expect(page.locator('code.language-mermaid')).toHaveCount(0)
  await expect(page.locator('.md h2').first()).toHaveText('汇总结果')
  // 元信息逐行展示：每项占满整行，不被全局 dl 网格排成多列。
  const meta = page.locator('.md-meta')
  await expect(meta).toBeVisible()
  const rows = meta.locator(':scope > div')
  const widths = await rows.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)))
  const box = Math.round((await meta.boundingBox()).width)
  for (const width of widths) expect(width).toBeGreaterThan(box - 40)
  const keys = await meta.locator('dt').evaluateAll((els) =>
    els.map((el) => {
      const value = el.nextElementSibling.getBoundingClientRect()
      return value.top >= el.getBoundingClientRect().bottom - 1
    }),
  )
  expect(keys.every(Boolean)).toBe(true)

  // 包内相对链接直接打开对应文件。
  await page.getByRole('button', { name: 'references/checklist.md' }).click()
  await page.locator('.md a', { hasText: '版本规范' }).click()
  await expect(page.getByLabel('Markdown 源码')).toHaveValue(/版本号必须与/)
  await expect(page.locator('.md h1')).toHaveText('版本规范')
})

test('目录修订过期时保存返回冲突并保留草稿', async ({ page }) => {
  await seed(page, 'e2e-conflict', { 'FLOW.md': quick })
  await openFlow(page, 'e2e-conflict')
  // 画布改名产生草稿，随后别处又提交了一次修订。
  await page.locator('.cnode').click()
  await page.getByLabel('节点名称').fill('本地草稿')
  const current = await storedFlow(page, 'e2e-conflict')
  const elsewhere = await api(page, '/flows/e2e-conflict', 'PUT', {
    files: { 'FLOW.md': current.files['FLOW.md'] + '\n<!-- 别处的改动 -->\n' },
    expectedRevision: current.revision,
  })
  expect(elsewhere.status).toBe(200)
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('alert').first()).toContainText('冲突')
  // 草稿仍在画布上，重新载入前不会丢失。
  await expect(page.locator('.cnode-title')).toHaveText('本地草稿')
  await expect(page.getByRole('button', { name: '保存' })).toBeEnabled()
})

const agentFlow = `---
name: 会话轨迹验收
description: 新建 Agent 后复用同一会话完成任务。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> analyze[分析任务]
  analyze -->|已分析| finishNode[完成任务]
  finishNode -->|已完成| finish((结束))
\`\`\`

## 分析任务

\`\`\`新建Agent
分析任务，然后通过结果工具提交「已分析」。
\`\`\`

### 已分析

已给出分析结论。

## 完成任务

\`\`\`复用Agent
根据上一节点结论完成任务，然后提交「已完成」。
\`\`\`

### 已完成

任务已结束。
`

test('Agent 节点的会话轨迹与流转图', async ({ page }) => {
  await seed(page, 'e2e-agent', { 'FLOW.md': agentFlow })
  await openFlow(page, 'e2e-agent')
  await page.getByRole('button', { name: '启动运行' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Run ID（可选）').fill('e2e-agent-run')
  await dialog.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-agent-run$/)
  // 流转图按事实标记节点状态，点节点可以跳到对应的执行记录。
  await expect(page.locator('.runflow .cnode')).toHaveCount(2)
  await expect(page.locator('.rnode[data-run-status="completed"]').first()).toBeVisible({ timeout: 20000 })
  await page.getByRole('tab', { name: '节点执行' }).click()
  await page.getByRole('button', { name: /分析任务/ }).first().click()
  await expect(page.locator('.trajectory-host')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-kind="user"]').first()).toBeVisible()
  await expect(page.locator('[data-kind="tool"]').first()).toBeVisible()
  // 第二次节点执行是同一会话的切片，轨迹同样可读。
  await page.getByRole('button', { name: /完成任务/ }).first().click()
  await expect(page.locator('.trajectory-host')).toBeVisible({ timeout: 15000 })
})

test('停止运行与运行配置', async ({ page }) => {
  await seed(page, 'e2e-slow', { 'FLOW.md': slow })
  await openFlow(page, 'e2e-slow')
  await page.getByRole('button', { name: '启动运行' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Run ID（可选）').fill('e2e-slow-run')
  await dialog.getByRole('button', { name: '启动运行' }).click()
  await expect(page).toHaveURL(/\/#\/runs\/e2e-slow-run$/)
  await expect(page.locator('[data-status="running"]')).toBeVisible()
  // 流转图标出当前正在执行的节点。
  await expect(page.locator('.rnode.is-current')).toBeVisible()
  await page.getByRole('button', { name: '停止运行' }).click()
  await page.getByRole('button', { name: '确认停止' }).click()
  await expect(page.locator('[data-status="stopped"]')).toBeVisible({ timeout: 15000 })

  // 运行配置覆盖模型 provider 与并发；密钥不回显，留空表示沿用。
  await page.getByLabel('主导航').getByRole('link', { name: '运行配置' }).click()
  await expect(page.getByLabel('密钥')).toHaveAttribute('placeholder', '已配置，留空则不修改')
  await expect(page.getByLabel('服务地址')).toHaveValue('http://127.0.0.1:14485/v1')
  await page.getByLabel('服务地址').fill('https://api.example.com/v1')
  await page.getByLabel('模型标识').fill('example-model')
  await page.getByLabel('密钥').fill('sk-new')
  await page.getByLabel('最大并发数').fill('2')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible()
  await expect(page.getByLabel('密钥')).toHaveAttribute('placeholder', '已配置，留空则不修改')
  await expect(page.getByLabel('密钥')).toHaveValue('')
  const saved = await api(page, '/flow-config')
  expect(saved.body.provider).toMatchObject({
    baseUrl: 'https://api.example.com/v1',
    model: 'example-model',
    apiKeySet: true,
  })
  expect(saved.body.provider.apiKey).toBeUndefined()
  expect(saved.body.maxConcurrent).toBe(2)
})
