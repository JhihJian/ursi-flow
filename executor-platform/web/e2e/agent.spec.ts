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
    expect(page.getByRole('status')).toHaveText('已完成'),
    expect(page.getByText('结论：无需修改。', { exact: true })).toBeVisible(),
  ])

  const artifacts = page.getByRole('region', { name: '只读文件制品' })
  await artifacts.getByRole('button', { name: file, exact: true }).click()
  await expect(artifacts.getByLabel(`${file} 内容`)).toHaveText(content)
})

test('ACP 时间线持续更新，断线后续读，不把会话结束当作尝试成功', async ({ page, baseURL, isMobile }) => {
  let disconnected = false
  let finish = false
  const cursors: Array<[number, string | null]> = []
  const calls = await mockAgentApi(page, baseURL, (route, key, url, attempt) => {
    if (key === `PUT ${attempt.path}` || key === `GET ${attempt.path}`) {
      return route.fulfill({ json: { attemptId: attempt.id, status: finish ? 'succeeded' : 'running' } })
    }
    if (key !== `GET ${attempt.path}/events`) return
    const after = Number(url.searchParams.get('after'))
    const wait = url.searchParams.get('waitMs')
    cursors.push([after, wait])
    if (after === 0) return route.fulfill({ json: { events: [
      { seq: 2, kind: 'rpc', method: 'initialize', phase: 'ack', id: 'private-rpc-id' },
      { seq: 1, kind: 'rpc', method: 'initialize', phase: 'sent', params: { secret: 'private-prompt' } },
      { seq: 3, kind: 'message', messageId: 'private-message-id', chunk: true, text: '回复正文' },
      { seq: 4, kind: 'tool', toolCallId: 'private-tool-id', name: 'list_inputs', status: 'in_progress', output: 'private-output' },
    ], nextCursor: 4 } })
    if (after === 4 && !disconnected) {
      disconnected = true
      return route.abort('failed')
    }
    if (after === 4) return route.fulfill({ json: { events: [
      { seq: 5, kind: 'tool', toolCallId: 'private-tool-id', status: 'completed' },
      { seq: 6, kind: 'state', state: 'idle', stopReason: 'end_turn' },
      { seq: 7, kind: 'rpc', method: 'session/close', phase: 'ack' },
    ], nextCursor: 7 } })
    if (after === 7 && wait === null && finish) return route.fulfill({ json: { events: [
      { seq: 8, kind: 'gap', reason: 'event_write_failed' },
    ], nextCursor: 8 } })
    return route.fulfill({ json: emptyPage(after) })
  })
  await openAgent(page, calls)
  const panel = page.getByRole('complementary', { name: 'ACP 执行过程' })
  const events = panel.getByRole('region', { name: 'ACP 事件' })
  const status = page.getByRole('status').filter({ hasText: /运行中|已完成/ })
  if (isMobile) {
    await expect(events).toBeHidden()
    await panel.getByRole('button', { name: '展开 ACP 执行过程' }).click()
  } else {
    const dialogue = await page.getByLabel('任务对话').boundingBox()
    const trace = await panel.boundingBox()
    expect(trace!.x).toBeGreaterThanOrEqual(dialogue!.x + dialogue!.width)
  }
  await submitInstruction(page)
  await expect(panel.getByRole('alert')).toHaveText('读取轨迹失败')
  await expect(events.getByRole('listitem')).toHaveCount(4)
  await expect(page.getByText('回复正文', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '重试读取' }).click()
  await expect(events.getByRole('listitem')).toHaveText([
    /1.*initialize.*已发送/, /2.*initialize.*收到回执/, /3.*收到回复片段/,
    /4.*list_inputs.*运行中/, /5.*list_inputs.*已完成/, /6.*会话状态：空闲/, /7.*session\/close.*收到回执/,
  ])
  await expect(panel).not.toContainText(/private-|回复正文/)
  await expect(status).toHaveText('运行中')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect(cursors.slice(0, 3)).toEqual([[0, null], [4, '8000'], [4, null]])

  finish = true
  await expect(status).toHaveText('已完成')
  await expect(events.getByRole('listitem').last()).toContainText('轨迹缺口')
  await expect.poll(() => cursors).toContainEqual([8, null])
  expect(calls.filter(key => key.startsWith('PUT '))).toHaveLength(1)
  if (isMobile) {
    await panel.getByRole('button', { name: '折叠 ACP 执行过程' }).click()
    await expect(events).toBeHidden()
  }
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
