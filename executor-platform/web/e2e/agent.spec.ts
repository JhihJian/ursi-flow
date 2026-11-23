import { expect, test, type Page, type Route } from '@playwright/test'

const api = '/api/v2'
const executorRef = { id: 'pi-default', revision: 1 }
const revision = { ...executorRef, agent: { configPackageId: 'cfg', backendId: 'pi' } }
const instruction = '  核对资料\n给出结论  '
const attemptsPath = `${api}/executor-attempts`

type Attempt = { id: string; path: string }
type HandleAttempt = (route: Route, key: string, url: URL, attempt: Attempt) => Promise<void> | undefined

async function mockAgentApi(page: Page, baseURL: string | undefined, handle: HandleAttempt) {
  const calls: string[] = []
  let attempt: Attempt | undefined
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`
    calls.push(key)
    expect(url.origin).toBe(baseURL)
    expect(request.headers().authorization).toBe('Bearer platform-token')
    if (key === `GET ${api}/executors`) return route.fulfill({ json: [{ ...revision, active: true }] })
    if (key === `GET ${api}/executors/pi-default/revisions`) return route.fulfill({ json: [revision] })
    if (request.method() === 'PUT' && url.pathname.startsWith(`${attemptsPath}/`)) {
      expect(attempt, '只能提交一次，查回或新建空白尝试不重发').toBeUndefined()
      const id = url.pathname.slice(attemptsPath.length + 1)
      expect(id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
      expect(request.postDataJSON()).toEqual({ executorRef, workInstruction: { encoding: 'utf-8', text: instruction } })
      attempt = { id, path: url.pathname }
    }
    const response = attempt && handle(route, key, url, attempt)
    if (response) return response
    throw new Error(`意外请求：${key}${url.search}`)
  })
  return calls
}

async function openAgent(page: Page, calls: string[], path = '/agent') {
  await page.addInitScript(() => sessionStorage.setItem('ursi-flow:bearer', 'workbench-only'))
  await page.goto(path)
  await expect(page).toHaveURL(/\/agent$/)
  await expect(page.getByRole('heading', { name: '登录执行器管理平台' })).toBeVisible()
  expect(calls).toEqual([])
  await page.getByLabel('访问令牌').fill('platform-token')
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

const send = (page: Page) => page.getByRole('button', { name: '发送', exact: true })
const retry = (page: Page) => page.getByRole('button', { name: '重新查询', exact: true })

async function submitInstruction(page: Page) {
  const picker = page.getByRole('combobox', { name: 'Agent 修订' })
  const option = picker.getByRole('option', { name: /pi-default/ })
  await expect(option).toHaveCount(1)
  await picker.selectOption({ label: await option.textContent() ?? '' })
  await page.getByRole('textbox', { name: '任务指令' }).fill(instruction)
  await send(page).click()
}

const emptyPage = (nextCursor: number) => ({ events: [], nextCursor })

test('默认工作区在提交回执丢失和早期 404 后，刷新只查询原尝试', async ({ page, baseURL }) => {
  let available = false
  const calls = await mockAgentApi(page, baseURL, (route, key, url, attempt) => {
    if (key === `PUT ${attempt.path}`) return route.abort('failed')
    if (key === `GET ${attempt.path}`) {
      return available
        ? route.fulfill({ json: { attemptId: attempt.id, status: 'succeeded' } })
        : route.fulfill({ status: 404, json: { error: '尝试尚不可查' } })
    }
    if (key === `GET ${attempt.path}/events`) {
      return available
        ? route.fulfill({ json: emptyPage(Number(url.searchParams.get('after'))) })
        : route.fulfill({ status: 404, json: { error: '尝试尚不可查' } })
    }
  })
  await openAgent(page, calls, '/')
  const [firstMissing] = await Promise.all([
    page.waitForResponse(response => {
      const path = new URL(response.url()).pathname
      return response.status() === 404 && response.request().method() === 'GET'
        && path.startsWith(`${attemptsPath}/`) && !path.endsWith('/events')
    }),
    submitInstruction(page),
  ])
  const original = new URL(firstMissing.url()).pathname
  await expect(retry(page)).toBeEnabled()
  await expect(send(page)).toBeDisabled()

  await Promise.all([
    page.waitForResponse(response => response.status() === 404
      && response.request().method() === 'GET' && new URL(response.url()).pathname === original),
    page.reload(),
  ])
  await expect(retry(page)).toBeEnabled()
  available = true
  await retry(page).click()
  await expect(page.getByText('已完成', { exact: true })).toBeVisible()
  expect(calls.filter(key => key.startsWith('PUT '))).toEqual([`PUT ${original}`])
})

test('归并同一回复的片段，尝试完成后读完事件并打开只读制品', async ({ page, baseURL }) => {
  const artifactDirectoryId = 'report-files'
  const file = 'reports/result.txt'
  const content = '制品内容：审核通过。'
  const pages = new Map([
    [0, { events: [
      { seq: 1, kind: 'message', messageId: 'analysis', chunk: true, text: '资料核对' },
      { seq: 2, kind: 'message', messageId: 'analysis', chunk: true, text: '完毕。' },
      { seq: 3, kind: 'tool', toolCallId: 'check', name: '核对资料', status: 'in_progress' },
    ], nextCursor: 3 }],
    [3, { events: [
      { seq: 4, kind: 'tool', toolCallId: 'check', status: 'completed' },
      { seq: 5, kind: 'message', messageId: 'conclusion', chunk: true, text: '结论：' },
    ], nextCursor: 5 }],
    [5, { events: [
      { seq: 6, kind: 'message', messageId: 'conclusion', chunk: true, text: '无需修改。' },
      { seq: 7, kind: 'state', state: 'idle', stopReason: 'end_turn' },
    ], nextCursor: 7 }],
  ])
  let finish = false
  let terminal = false
  const calls = await mockAgentApi(page, baseURL, (route, key, url, attempt) => {
    if (key === `PUT ${attempt.path}`) return route.fulfill({ json: { attemptId: attempt.id, status: 'running' } })
    if (key === `GET ${attempt.path}`) {
      terminal = finish
      return route.fulfill({ json: terminal
        ? { attemptId: attempt.id, status: 'succeeded', artifactDirectoryId }
        : { attemptId: attempt.id, status: 'running' } })
    }
    if (key === `GET ${attempt.path}/events`) {
      const after = Number(url.searchParams.get('after'))
      expect([0, 3, 5, 7]).toContain(after)
      return route.fulfill({ json: (after === 0 || terminal ? pages.get(after) : undefined) ?? emptyPage(after) })
    }
    if (key === `GET ${api}/directories/${artifactDirectoryId}/tree`) {
      expect(terminal).toBe(true)
      return route.fulfill({ json: [{ path: file, kind: 'file' }] })
    }
    if (key === `GET ${api}/directories/${artifactDirectoryId}/file`) {
      expect(url.searchParams.get('path')).toBe(file)
      return route.fulfill({ contentType: 'application/octet-stream', body: content })
    }
  })
  await openAgent(page, calls)
  const readAfter = (cursor: number) => page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/events') && url.searchParams.get('after') === String(cursor) && response.ok()
  })
  // 运行期间的空页不代表轨迹结束，终态出现时仍需从该游标继续读。
  await Promise.all([readAfter(3), submitInstruction(page)])
  await expect(page.getByText('资料核对完毕。', { exact: true })).toBeVisible()
  const drained = readAfter(7)
  finish = true
  await Promise.all([
    drained,
    expect(page.getByText('已完成', { exact: true })).toBeVisible(),
    expect(page.getByText('结论：无需修改。', { exact: true })).toBeVisible(),
  ])

  const artifacts = page.getByRole('region', { name: '只读文件制品' })
  await artifacts.getByRole('button', { name: file, exact: true }).click()
  await expect(artifacts.getByLabel(`${file} 内容`)).toHaveText(content)
})

test('停止运行中的尝试后显示服务确认的取消结果，可新建空白尝试', async ({ page, baseURL }) => {
  const calls = await mockAgentApi(page, baseURL, (route, key, url, attempt) => {
    if (key === `PUT ${attempt.path}` || key === `GET ${attempt.path}`) {
      return route.fulfill({ json: { attemptId: attempt.id, status: 'running' } })
    }
    if (key === `GET ${attempt.path}/events`) {
      return route.fulfill({ json: emptyPage(Number(url.searchParams.get('after'))) })
    }
    if (key === `POST ${attempt.path}/cancel`) {
      return route.fulfill({ json: { attemptId: attempt.id, status: 'cancelled' } })
    }
  })
  await openAgent(page, calls)
  await submitInstruction(page)
  const stop = page.getByRole('button', { name: '停止', exact: true })
  await stop.click()
  const result = page.getByText('已取消', { exact: true })
  await expect(result).toBeVisible()
  const [put] = calls.filter(key => key.startsWith('PUT '))
  expect(calls.filter(key => key.startsWith('POST '))).toEqual([`POST ${put.slice(4)}/cancel`])
  await page.getByRole('button', { name: '新建尝试', exact: true }).click()
  await expect(result).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '任务指令' })).toHaveValue('')
})
