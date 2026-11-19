import { test, expect, navigate, expectNoOverflow } from './fixtures'
import type { FlowFiles, FlowConfig } from '../src/shared/api/types'

test('完整包往返、运行启停与历史、配置更新均遵循 v1 契约', async ({ page }) => {
  let files: FlowFiles | null = null
  let revision = 0
  let status = 'running'
  let validated = false
  let rejectUpdate = true
  let config: FlowConfig = { executor: 'local-pi', model: '', maxConcurrent: 4 }
  const job = () => ({ id: 'r1', flow: 'example', revision: String(revision), status, cwd: '/workspace', variables: { note: 3 }, config })
  await page.route('**/api/**', async route => {
    const req = route.request()
    expect(req.headers().authorization).toBe('Bearer browser-canary')
    const url = new URL(req.url()); expect(url.search).toBe('')
    const op = `${req.method()} ${url.pathname}`
    const ok = (json: unknown) => route.fulfill({ json })
    const body = req.postDataJSON()
    switch (op) {
      case 'GET /api/v2/sources': return ok([])
      case 'GET /api/v1/flows': return ok(files ? ['example'] : [])
      case 'POST /api/v1/flows/validate':
        expect(body.id).toBe('example'); expect(body.files['references/guide.md']).toBe('初稿'); validated = true
        return ok({ id: body.id, valid: true })
      case 'POST /api/v1/flows':
        expect(validated).toBe(true); expect(Object.keys(body).sort()).toEqual(['files', 'id']); files = body.files
        return ok({ id: 'example', revision: String(++revision) })
      case 'GET /api/v1/flows/example': return ok({ id: 'example', revision: String(revision), files })
      case 'PUT /api/v1/flows/example':
        expect(body).toEqual({ expectedRevision: '1', files: { ...files, 'references/guide.md': '定稿' } })
        if (rejectUpdate) { rejectUpdate = false; return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'Conflict' } } }) }
        files = body.files; return ok({ id: 'example', revision: String(++revision) })
      case 'POST /api/v1/flows/example/runs':
        expect(body).toEqual({ workspace: 'default', runId: 'r1', variables: { note: 3 } }); return ok(job())
      case 'GET /api/v1/runs': return ok([job()])
      case 'GET /api/v1/runs/r1': return ok(job())
      case 'GET /api/v1/runs/r1/history': return ok({ job: job(), runs: [], nodeRuns: [{ nodeId: 'task' }], routeDecisions: [] })
      case 'POST /api/v1/runs/r1/stop': status = 'stopped'; return ok(job())
      case 'GET /api/v1/flow-config': return ok(config)
      case 'PATCH /api/v1/flow-config': expect(body).toEqual({ model: 'test-model', maxConcurrent: 6 }); config = { ...config, ...body }; return ok(config)
      case 'DELETE /api/v1/flows/example': files = null; return ok({ id: 'example', revision: String(++revision) })
      default: throw Error(`意外 API：${op}`)
    }
  })
  await page.goto('/flows')
  await page.getByLabel('访问令牌').fill('browser-canary')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('暂无 Flow 包')).toBeVisible()
  await page.getByRole('link', { name: '创建 Flow' }).click()
  await page.getByLabel('Flow ID').fill('example')
  await page.getByLabel('新增文件路径').fill('references/guide.md')
  await page.getByRole('button', { name: '添加文件' }).click()
  await page.getByLabel('references/guide.md', { exact: true }).fill('初稿')
  await page.getByRole('button', { name: '验证包' }).click()
  await expect(page.getByText('包验证通过。')).toBeVisible()
  await page.getByRole('button', { name: '保存 Flow' }).click()
  await expect(page).toHaveURL(/\/flows\/example\/edit$/)
  await page.reload()
  await page.getByRole('button', { name: 'references/guide.md' }).click()
  const editor = page.getByRole('textbox', { name: 'references/guide.md', exact: true })
  await expect(editor).toHaveValue('初稿'); await editor.fill('定稿')
  await page.getByRole('button', { name: '保存 Flow' }).click()
  await expect(page.getByRole('alert')).toContainText('409'); await expect(editor).toHaveValue('定稿')
  await page.getByRole('button', { name: '保存 Flow' }).click()
  await expect(page.getByText('Revision：2')).toBeVisible()
  await page.getByLabel('Run ID（选填）').fill('r1'); await page.getByLabel('变量（JSON 对象）').fill('{"note":3}')
  await page.getByRole('button', { name: '启动 Run' }).click()
  await expect(page).toHaveURL(/\/runs\/r1$/); await expect(page.getByText('nodeRuns (1)')).toBeVisible()
  await page.getByRole('button', { name: '停止 Run' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByText('状态：stopped')).toBeVisible(); await expectNoOverflow(page)
  await page.getByRole('link', { name: '返回列表' }).click(); await expect(page.getByRole('link', { name: /r1.*example.*stopped/ })).toBeVisible()
  await navigate(page, '运行配置'); await page.getByLabel('模型').fill('test-model'); await page.getByLabel('最大并发数').fill('6')
  await page.getByRole('button', { name: '保存配置' }).click(); await expect(page.getByText('配置已保存。')).toBeVisible()
  await page.reload(); await expect(page.getByLabel('最大并发数')).toHaveValue('6')
  await navigate(page, 'Flow 包'); await page.getByRole('link', { name: 'example' }).click()
  await page.getByRole('button', { name: '删除 Flow' }).click(); await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('暂无 Flow 包')).toBeVisible()
})
