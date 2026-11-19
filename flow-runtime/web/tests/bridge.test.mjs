import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConsole } from '../server.mjs'

const token = 'test-only-console-token'
const auth = { Authorization: `Bearer ${token}` }

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
  const server = await createConsole({
    URSI_FLOW_HOME: daemon.home,
    URSI_FLOW_WEB_TOKEN: token,
    URSI_FLOW_WORKDIR: workdir,
    ...extra,
  })
  const base = await listen(t, server)
  return { base, workdir }
}

test('演示模式只提供静态配置，没有 Runtime 接口', async (t) => {
  const base = await listen(t, await createConsole({}))
  assert.deepEqual(await (await fetch(base + '/console-config.json')).json(), {
    mode: 'demo',
    auth: false,
  })
  assert.equal((await fetch(base + '/api/v1/flows')).status, 404)
})

test('实时模式缺少令牌或工作目录时拒绝启动', async () => {
  await assert.rejects(() => createConsole({ URSI_FLOW_WEB_TOKEN: token }))
  await assert.rejects(() =>
    createConsole({ URSI_FLOW_WEB_TOKEN: 'short', URSI_FLOW_WORKDIR: '/tmp' }),
  )
})

test('实时配置暴露工作区，认证头缺失或错误时返回 401', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base, workdir } = await liveConsole(t, daemon)
  assert.deepEqual(await (await fetch(base + '/console-config.json')).json(), {
    mode: 'live',
    auth: true,
    apiBase: '/api/v1',
    workspace: { name: 'default', path: workdir },
  })
  const missing = await fetch(base + '/api/v1/flows')
  assert.equal(missing.status, 401)
  assert.match(missing.headers.get('www-authenticate') || '', /^Bearer/)
  assert.equal(
    (await fetch(base + '/api/v1/flows', { headers: { Authorization: 'Bearer nope' } })).status,
    401,
  )
  assert.equal(daemon.calls.length, 0)
})

test('每个同源路由都翻译成对应的 daemon 操作', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base, workdir } = await liveConsole(t, daemon)
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? auth : { ...auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.equal(response.status, 200, path)
    return response.json()
  }
  const files = { 'FLOW.md': '# flow' }

  assert.deepEqual(await call('GET', '/api/v1/flows'), { op: 'flow.list' })
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
  await call('POST', '/api/v1/runs/run-1/stop')
  await call('GET', '/api/v1/flow-config')
  await call('PATCH', '/api/v1/flow-config', { maxConcurrent: 2 })

  assert.deepEqual(
    daemon.calls.map((request) => request.op),
    [
      'flow.list',
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
      'run.stop',
      'config.get',
      'config.update',
    ],
  )
  assert.ok(
    daemon.calls.every((request) => request.v === 1),
    '请求必须携带协议版本',
  )
  assert.deepEqual(daemon.calls[1].args, { id: 'ordinary', files })
  assert.deepEqual(daemon.calls[3].args, { id: 'validate' })
  assert.deepEqual(daemon.calls[4].args, { id: 'ordinary', files, expectedRevision: 'rev-1' })
  assert.deepEqual(
    daemon.calls[5].args,
    { id: 'ordinary', files },
    '未提供修订时不能补默认值',
  )
  assert.deepEqual(daemon.calls[7].args, {
    id: 'run-1',
    flow: 'ordinary',
    cwd: workdir,
    variables: { 任务: '检查' },
  })
  assert.deepEqual(daemon.calls[14].args, { maxConcurrent: 2 })
})

test('启动运行只接受 default 工作区，缺省 Run ID 由服务端生成', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base, workdir } = await liveConsole(t, daemon)
  const post = (body) =>
    fetch(base + '/api/v1/flows/ordinary/runs', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const rejected = await post({ workspace: '/tmp', variables: {} })
  assert.equal(rejected.status, 400)
  assert.equal(daemon.calls.length, 0)
  assert.equal((await post({ workspace: 'default', variables: [] })).status, 400)
  assert.equal(daemon.calls.length, 0)

  assert.equal((await post({ workspace: 'default', variables: {} })).status, 200)
  const args = daemon.calls[0].args
  assert.match(args.id, /^[0-9a-f-]{36}$/)
  assert.equal(args.cwd, workdir)
  assert.deepEqual(args.variables, {})
})

test('daemon 错误码按 workbench 映射，业务文案透传', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base } = await liveConsole(t, daemon)
  const read = async () => {
    const response = await fetch(base + '/api/v1/flows', { headers: auth })
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
  const missing = await fetch(base + '/api/v1/runs', { headers: auth })
  assert.equal(missing.status, 503)
  assert.equal((await missing.json()).error.code, 'runtime_unavailable')

  const server = await createConsole({
    URSI_FLOW_HOME: daemon.home,
    URSI_FLOW_WEB_TOKEN: token,
    URSI_FLOW_WORKDIR: daemon.home,
  })
  const other = await listen(t, server)
  const large = await fetch(other + '/api/v1/flows', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'big', files: { 'FLOW.md': 'x'.repeat(3 * 1024 * 1024) } }),
  })
  assert.equal(large.status, 413)
  assert.equal(daemon.calls.length, 0)
})

test('静态路径只允许入口与构建资源，API 拼错不落到 HTML', async (t) => {
  const daemon = await fakeDaemon(t)
  const { base } = await liveConsole(t, daemon)
  for (const path of [
    '/assets/../../etc/passwd',
    '/%2e%2e%2fpackage.json',
    '/index.html/../../etc/passwd',
  ]) {
    assert.equal((await fetch(base + path)).status, 404, path)
  }
  const unknown = await fetch(base + '/api/v1/unknown', { headers: auth })
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
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/)
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
})
