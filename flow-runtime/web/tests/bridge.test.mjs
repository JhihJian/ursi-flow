import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConsole } from '../server.mjs'

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return 'http://127.0.0.1:' + server.address().port
}

// 假 daemon：只在收到写端半关闭后回包，能验证桥确实按协议收尾。
async function fakeDaemon(t) {
  const home = await mkdtemp(join(tmpdir(), 'flow-console-'))
  const socketPath = join(home, 'runtime.sock')
  const calls = []
  let handler = (request) => ({ v: 1, data: { op: request.op } })
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = []
    socket.on('error', () => {})
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push(request)
      socket.end(JSON.stringify(handler(request)) + '\n')
    })
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  })
  return {
    home,
    socketPath,
    calls,
    respond(fn) {
      handler = fn
    },
  }
}

async function liveConsole(t, daemon, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'flow-work-'))
  const workdir = await realpath(dir)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = await createConsole({ URSI_FLOW_HOME: daemon.home, URSI_FLOW_WORKDIR: workdir, ...extra })
  const base = await listen(t, server)
  return { base, workdir }
}

// 写请求需要同源标记，模拟浏览器自动携带的请求头。
const writeHeaders = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }

test('没有展示用工作区时也读取 Runtime 目录', async (t) => {
  const daemon = await fakeDaemon(t)
  const base = await listen(t, await createConsole({ URSI_FLOW_HOME: daemon.home }))
  assert.deepEqual(await (await fetch(base + '/console-config.json')).json(), { apiBase: '/api/v1' })
  assert.deepEqual(await (await fetch(base + '/api/v1/flows')).json(), { op: 'flow.list' })
})

test('可选展示工作区，不需要访问令牌', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base, workdir } = await liveConsole(t, daemon)
  assert.deepEqual(await (await fetch(base + '/console-config.json')).json(), {
    apiBase: '/api/v1',
    workspace: { name: 'default', path: workdir },
  })
  const list = await fetch(base + '/api/v1/flows')
  assert.equal(list.status, 200)
  assert.deepEqual(await list.json(), { op: 'flow.list' })
})

test('工作目录无效时拒绝启动', async () => {
  await assert.rejects(() => createConsole({ URSI_FLOW_WORKDIR: '/nonexistent-workdir' }))
})

test('每个同源路由都翻译成对应的 daemon 操作', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base, workdir } = await liveConsole(t, daemon)
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : writeHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.equal(response.status, 200, path)
    return response.json()
  }
  const files = { 'FLOW.md': '# flow' }

  assert.deepEqual(await call('GET', '/api/v1/flows'), { op: 'flow.list' })
  // 列表页一次取回名称与规模，避免逐个读包。
  assert.deepEqual(await call('GET', '/api/v1/flows?detail=1'), { op: 'flow.summaries' })
  await call('POST', '/api/v1/flows', { id: 'ordinary', files })
  await call('POST', '/api/v1/flows/validate', { id: 'ordinary', files })
  await call('GET', '/api/v1/flows/validate')
  await call('PUT', '/api/v1/flows/ordinary', { files, expectedRevision: 'rev-1' })
  await call('PUT', '/api/v1/flows/ordinary', { files })
  await call('DELETE', '/api/v1/flows/ordinary')
  await call('POST', '/api/v1/flows/ordinary/runs', {
    runId: 'run-1',
    workspace: 'default',
    variables: { 任务: '检查' },
  })
  await call('GET', '/api/v1/flows/ordinary')
  await call('GET', '/api/v1/runs')
  await call('GET', '/api/v1/runs/run-1')
  await call('GET', '/api/v1/runs/run-1/history')
  await call('GET', '/api/v1/runs/run-1/flow')
  await call('GET', '/api/v1/runs/run-1/nodes/node-1/trajectory')
  await call('POST', '/api/v1/runs/run-1/stop')
  await call('GET', '/api/v1/flow-config')
  await call('PATCH', '/api/v1/flow-config', { maxConcurrent: 2 })

  assert.deepEqual(
    daemon.calls.map((request) => request.op),
    [
      'flow.list',
      'flow.summaries',
      'flow.create',
      'flow.validate',
      'flow.get',
      'flow.update',
      'flow.update',
      'flow.delete',
      'run.start',
      'flow.get',
      'run.list',
      'run.get',
      'run.history',
      'run.flow',
      'run.trajectory',
      'run.stop',
      'config.get',
      'config.update',
    ],
  )
  assert.ok(daemon.calls.every((request) => request.v === 1), '请求必须携带协议版本')
  // 下标以 calls 顺序为准：0 是列表，1 是摘要，之后是创建。
  assert.deepEqual(daemon.calls[0].args, {})
  assert.deepEqual(daemon.calls[1].args, {})
  assert.deepEqual(daemon.calls[2].args, { id: 'ordinary', files })
  assert.deepEqual(daemon.calls[4].args, { id: 'validate' })
  assert.deepEqual(daemon.calls[5].args, { id: 'ordinary', files, expectedRevision: 'rev-1' })
  assert.deepEqual(daemon.calls[6].args, { id: 'ordinary', files }, '未提供修订时不能补默认值')
  assert.deepEqual(daemon.calls[13].args, { id: 'run-1' })
  assert.deepEqual(daemon.calls[14].args, { id: 'run-1', node: 'node-1' })
  // 请求没带工作目录时不补默认值，交给 daemon 按工作区根目录新建。
  assert.deepEqual(daemon.calls[8].args, {
    id: 'run-1',
    flow: 'ordinary',
    variables: { 任务: '检查' },
  })
  assert.deepEqual(daemon.calls[17].args, { maxConcurrent: 2 })

  const executorRef = { id: 'reviewer', revision: 7 }
  await call('POST', '/api/v1/flows/ordinary/runs', { runId: 'remote', executorRef })
  assert.deepEqual(daemon.calls.at(-1).args.executorRef, executorRef)
  await call('POST', '/api/v1/runs/remote/resume')
  assert.deepEqual(daemon.calls.at(-1), { v: 1, op: 'run.resume', args: { id: 'remote' } })
})

test('启动运行只接受 default 工作区，缺省 Run ID 由服务端生成', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base } = await liveConsole(t, daemon)
  const post = (body) =>
    fetch(base + '/api/v1/flows/ordinary/runs', {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify(body),
    })
  assert.equal((await post({ workspace: '/tmp', variables: {} })).status, 400)
  assert.equal(daemon.calls.length, 0)
  assert.equal((await post({ workspace: 'default', variables: [] })).status, 400)
  assert.equal(daemon.calls.length, 0)

  assert.equal((await post({ workspace: 'default', variables: {} })).status, 200)
  const args = daemon.calls[0].args
  assert.match(args.id, /^[0-9a-f-]{36}$/)
  assert.ok(!('cwd' in args), '未指定工作目录时由 daemon 决定')
  assert.deepEqual(args.variables, {})

  // 指定目录时原样转给 daemon。
  assert.equal((await post({ workspace: 'default', variables: {}, cwd: '/tmp' })).status, 200)
  assert.equal(daemon.calls[1].args.cwd, '/tmp')
})

test('跨站写入与未知 Host 被拒绝，GET 保持可用', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base } = await liveConsole(t, daemon)
  const crossSite = await fetch(base + '/api/v1/flows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ id: 'x', files: { 'FLOW.md': '# x' } }),
  })
  assert.equal(crossSite.status, 403)
  assert.equal((await crossSite.json()).error.code, 'cross_origin')

  const crossOrigin = await fetch(base + '/api/v1/flows', {
    method: 'DELETE',
    headers: { Origin: 'https://evil.example' },
  })
  assert.equal(crossOrigin.status, 403)

  // fetch 会强制使用 URL 的 Host，这里直接用 http.request 检查域名重绑定。
  const raw = (address, host) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: new URL(address).port, path: '/api/v1/flows', headers: { host } },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () =>
            resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
          )
        },
      )
      request.on('error', reject)
      request.end()
    })
  const foreignHost = await raw(base, 'evil.example')
  assert.equal(foreignHost.status, 403)
  assert.equal(JSON.parse(foreignHost.body).error.code, 'host_not_allowed')
  assert.equal(daemon.calls.length, 0)

  const registered = await listen(
    t,
    await createConsole({
      URSI_FLOW_HOME: daemon.home,
      URSI_FLOW_WORKDIR: daemon.home,
      URSI_FLOW_WEB_HOSTS: 'flow.internal',
    }),
  )
  assert.equal((await raw(registered, 'flow.internal')).status, 200)
})

test('daemon 错误码按 workbench 映射，业务文案透传', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base } = await liveConsole(t, daemon)
  const read = async () => {
    const response = await fetch(base + '/api/v1/flows')
    return { status: response.status, body: await response.json() }
  }
  const cases = [
    [{ v: 1, error: 'Flow 不存在', code: 'not_found' }, 404, 'not_found'],
    [{ v: 1, error: '版本冲突', code: 'conflict' }, 409, 'conflict'],
    [{ v: 1, error: '达到运行并发上限', code: 'busy' }, 429, 'runtime_busy'],
    [{ v: 1, error: '非法的结果边', code: 'invalid_input' }, 400, 'invalid_request'],
    [{ v: 1, error: '意外失败' }, 500, 'internal_error'],
    [{ v: 2, data: [] }, 502, 'runtime_protocol_error'],
    [{ v: 1, data: [], error: '两个都给' }, 502, 'runtime_protocol_error'],
  ]
  for (const [reply, status, code] of cases) {
    daemon.respond(() => reply)
    const result = await read()
    assert.equal(result.status, status)
    assert.equal(result.body.error.code, code)
  }
  daemon.respond(() => ({ v: 1, error: '非法的结果边', code: 'invalid_input' }))
  assert.equal((await read()).body.error.message, '非法的结果边')
})

test('Runtime 未启动时返回 503，写请求超限时不连接 daemon', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base } = await liveConsole(t, daemon)
  await rm(daemon.socketPath)
  const missing = await fetch(base + '/api/v1/runs')
  assert.equal(missing.status, 503)
  assert.equal((await missing.json()).error.code, 'runtime_unavailable')

  const other = await listen(
    t,
    await createConsole({ URSI_FLOW_HOME: daemon.home, URSI_FLOW_WORKDIR: daemon.home }),
  )
  const large = await fetch(other + '/api/v1/flows', {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ id: 'big', files: { 'FLOW.md': 'x'.repeat(3 * 1024 * 1024) } }),
  })
  assert.equal(large.status, 413)
  assert.equal(daemon.calls.length, 0)
})

test('静态路径只允许入口与构建资源，API 拼错不落到 HTML', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base } = await liveConsole(t, daemon)
  for (const path of ['/assets/../../etc/passwd', '/%2e%2e%2fpackage.json', '/index.html/../../etc/passwd']) {
    assert.equal((await fetch(base + path)).status, 404, path)
  }
  const unknown = await fetch(base + '/api/v1/unknown')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.headers.get('content-type'), 'application/json')
  assert.equal((await unknown.json()).error.code, 'not_found')
  assert.equal((await fetch(base + '/nope')).status, 404)
})

test('控制台配置带安全响应头且不缓存', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base } = await liveConsole(t, daemon)
  const response = await fetch(base + '/console-config.json')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const csp = response.headers.get('content-security-policy') || ''
  assert.match(csp, /frame-ancestors 'none'/)
  // 画布与图表依赖行内样式定位，脚本仍只允许同源。
  assert.match(csp, /style-src 'self' 'unsafe-inline'/)
  // 会话轨迹里的图片块是 data: URI。
  assert.match(csp, /img-src 'self' data: blob:/)
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/)
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
})
