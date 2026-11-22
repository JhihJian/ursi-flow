import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createConsole } from '../server.mjs'

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return 'http://127.0.0.1:' + server.address().port
}
test('缺少 Gateway 配置或 Web 身份时拒绝启动', () => {
  assert.throws(() => createConsole({}), /控制台需要 Gateway/)
  assert.throws(
    () => createConsole({ URSI_GATEWAY_URL: 'http://localhost' }),
    /控制台需要 Gateway/,
  )
  assert.throws(
    () =>
      createConsole({
        URSI_GATEWAY_URL: 'http://localhost',
        URSI_GATEWAY_KEY: 'test-only-key',
      }),
    /控制台需要 Gateway/,
  )
})
test('管理员写请求必须使用白名单路径和同源操作头', async (t) => {
  const calls = [],
    bodies = []
  const url = await listen(
    t,
    http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      calls.push(req.method + ' ' + req.url)
      bodies.push(body)
      res.end('{}')
    }),
  )
  const pass = 'example-admin-password'
  const base = await listen(
    t,
    createConsole({
      URSI_GATEWAY_URL: url,
      URSI_GATEWAY_KEY: 'test-only-gateway-key',
      URSI_WEB_ADMIN_PASSWORD: pass,
    }),
  )
  const headers = {
    Authorization: 'Basic ' + Buffer.from('admin:' + pass).toString('base64'),
  }
  const id = 'a'.repeat(32)
  const path = '/api/v1/sandboxes/' + id + '/stop'
  const rebuildPath = '/api/v1/sandboxes/' + id + '/rebuild'
  const post = (p, h, body) =>
    fetch(base + p, { method: 'POST', headers: h, body })
  assert.equal((await post(path, {})).status, 401)
  assert.equal((await post(path, headers)).status, 403)
  const h = { ...headers, 'X-Ursi-Action': 'manage' }
  assert.equal(
    (await post(path, { ...h, 'sec-fetch-site': 'cross-site' })).status,
    403,
  )
  assert.equal(
    (await post(path.replace('/stop', '/connect/web'), h)).status,
    405,
  )
  assert.equal((await post(path, h)).status, 200)
  assert.equal(
    (
      await post(
        rebuildPath,
        { ...h, 'content-type': 'application/json' },
        '{"preserve_data":true}',
      )
    ).status,
    200,
  )
  assert.deepEqual(calls, ['POST ' + path, 'POST ' + rebuildPath])
  assert.deepEqual(bodies, ['', '{"preserve_data":true}'])
})
test('查看者凭据与 Gateway 凭据独立，允许查询镜像和实例', async (t) => {
  const requests = []
  const url = await listen(
    t,
    http.createServer((req, res) => {
      requests.push([req.url, req.headers.authorization])
      res.end('{"ok":true}')
    }),
  )
  const password = 'read-only-example-password',
    key = 'test-only-management-key'
  const base = await listen(
    t,
    createConsole({
      URSI_GATEWAY_URL: url,
      URSI_GATEWAY_KEY: key,
      URSI_WEB_PASSWORD: password,
    }),
  )
  const headers = {
    Authorization:
      'Basic ' + Buffer.from('viewer:' + password).toString('base64'),
  }
  const list = '/api/v1/sandboxes',
    item = list + '/' + 'a'.repeat(32)
  assert.equal((await fetch(base + list)).status, 401)
  assert.deepEqual(
    await (await fetch(base + '/console-config.json', { headers })).json(),
    { mode: 'gateway', manage: false },
  )
  for (const path of [
    '/api/v1/capabilities',
    '/api/v1/images',
    list,
    item,
    item + '/logs?tail=200',
  ])
    assert.equal((await fetch(base + path, { headers })).status, 200)
  assert.equal(
    (await fetch(base + item, { method: 'DELETE', headers })).status,
    403,
  )
  assert.equal(
    (await fetch(base + item + '/connect/web', { headers })).status,
    404,
  )
  assert.deepEqual(
    requests,
    ['/api/v1/capabilities', '/api/v1/images', list, item, item + '/logs?tail=200'].map(
      (path) => [path, 'Bearer ' + key],
    ),
  )
})

const sandbox = 'ab'.repeat(16)
const observationId = 'd6af8ec4-036c-41fe-bab5-8f1303cbf95f'
const collection = `/api/v1/sandboxes/${sandbox}/observations`
const statusPath = `${collection}/${observationId}`
const segmentPath = `${statusPath}/segments/12`
const gatewayKey = 'test-observation-key'
const adminPass = 'test-observation-admin'
const viewerPass = 'test-observation-viewer'
const basic = (role, password) => 'Basic ' + Buffer.from(`${role}:${password}`).toString('base64')
const adminHeaders = { Authorization: basic('admin', adminPass) }
const manageHeaders = { ...adminHeaders, 'X-Ursi-Action': 'manage' }

async function observationConsole(t, handler) {
  return listen(t, createConsole({
    URSI_GATEWAY_URL: await listen(t, http.createServer(handler)),
    URSI_GATEWAY_KEY: gatewayKey,
    URSI_WEB_ADMIN_PASSWORD: adminPass,
    URSI_WEB_PASSWORD: viewerPass,
  }))
}

test('四条观测路由仅限管理员，写请求检查操作头及来源', async (t) => {
  const calls = []
  const base = await observationConsole(t, (req, res) => {
    calls.push([req.method, req.url, req.headers.authorization])
    res.writeHead(req.method === 'POST' ? 202 : 200)
    res.end('{"state":"running"}')
  })
  const routes = [['POST', collection], ['GET', statusPath], ['POST', statusPath + '/stop'], ['GET', segmentPath]]
  const viewer = { Authorization: basic('viewer', viewerPass), 'X-Ursi-Action': 'manage' }
  for (const [method, path] of routes) {
    const request = (headers) => fetch(base + path, { method, headers })
    assert.equal((await request({})).status, 401)
    assert.equal((await request(viewer)).status, 403)
    if (method === 'POST') {
      for (const headers of [adminHeaders, { ...manageHeaders, Origin: 'https://elsewhere.test' },
        { ...manageHeaders, 'Sec-Fetch-Site': 'cross-site' }])
        assert.equal((await request(headers)).status, 403)
    }
    const response = await request(method === 'POST' ? { ...manageHeaders, Origin: base } : adminHeaders)
    assert.equal(response.status, method === 'POST' ? 202 : 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    if (path !== segmentPath) assert.deepEqual(await response.json(), { state: 'running' })
    else await response.arrayBuffer()
  }
  assert.deepEqual(calls, routes.map(([method, path]) => [method, path, 'Bearer ' + gatewayKey]))
  const config = await fetch(base + '/console-config.json', { headers: adminHeaders })
  assert.match(config.headers.get('content-security-policy'), /(?:^|; )worker-src 'self'(?:;|$)/)
})

test('非白名单方法、标识符、分段编号和额外参数不转发', async (t) => {
  let calls = 0
  const base = await observationConsole(t, (_req, res) => { calls++; res.end('{}') })
  for (const path of [collection, statusPath + '/stop', statusPath + '/', statusPath.replace(sandbox, sandbox.slice(1)),
    statusPath.replace(observationId, observationId.replaceAll('-', '')), statusPath.replace(observationId, observationId.toUpperCase()),
    statusPath.replace(observationId, 'not-a-uuid'), segmentPath + '?tail=1',
    ...['0', '01', '-1', '1.2', '%31', '1/extra'].map((n) => `${statusPath}/segments/${n}`)]) {
    assert.equal((await fetch(base + path, { headers: adminHeaders })).status, 404, path)
  }
  for (const [method, path] of [['POST', segmentPath], ['POST', statusPath], ['DELETE', collection],
    ['PUT', statusPath + '/stop'], ['POST', collection + '?pid=1']]) {
    assert.equal((await fetch(base + path, { method, headers: manageHeaders })).status, 405, path)
  }
  assert.equal(calls, 0)
})

test('PCAP 首块即时可读，附件按原字节转发', async (t) => {
  const first = Buffer.from([0xa1, 0xb2, 0, 0xff]), last = Buffer.from([0, 0x80, 0xd4])
  let upstream
  const base = await observationConsole(t, (_req, res) => {
    upstream = res
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Disposition': 'inline', 'Cache-Control': 'public' })
    res.write(first)
  })
  const response = await fetch(base + segmentPath, { headers: adminHeaders, signal: AbortSignal.timeout(3000) })
  assert.equal(response.headers.get('content-type'), 'application/vnd.tcpdump.pcap')
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="[\w.-]+\.pcap"$/)
  const reader = response.body.getReader()
  const chunks = [Buffer.from((await reader.read()).value)]
  upstream.end(last)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, last]))
})

for (const phase of ['等待上游响应', '读取分段']) {
  test(`${phase}时取消下载会关闭上游连接`, { timeout: 4000 }, async (t) => {
    const opened = Promise.withResolvers(), closed = Promise.withResolvers()
    const base = await observationConsole(t, (_req, res) => {
      res.once('close', () => closed.resolve(res.writableEnded))
      if (phase === '读取分段') res.write(Buffer.from([0xff]))
      opened.resolve()
    })
    const client = new AbortController()
    const response = fetch(base + segmentPath, { headers: adminHeaders, signal: client.signal })
    await opened.promise
    if (phase === '读取分段') {
      const reader = (await response).body.getReader()
      assert.equal((await reader.read()).done, false)
      await reader.cancel()
    } else {
      client.abort()
      await assert.rejects(response, { name: 'AbortError' })
    }
    assert.equal(await closed.promise, false)
  })
}

test('分段错误保留 JSON 状态码，传输中断不追加错误响应', async (t) => {
  let interrupted
  const base = await observationConsole(t, (req, res) => {
    if (req.url === segmentPath) {
      res.writeHead(409)
      res.end(JSON.stringify({ error: { message: 'not ready: ' + gatewayKey } }))
    } else {
      interrupted = res
      res.write(Buffer.from([0xff]))
    }
  })
  const request = (path) => fetch(base + path, { headers: adminHeaders, signal: AbortSignal.timeout(3000) })
  const conflict = await request(segmentPath)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.headers.get('content-disposition'), null)
  assert.deepEqual(await conflict.json(), { error: { message: 'not ready: [已隐藏]' } })
  const reader = (await request(segmentPath + '1')).body.getReader()
  assert.deepEqual((await reader.read()).value, Uint8Array.of(0xff))
  interrupted.destroy()
  await assert.rejects(reader.read())
  assert.equal((await request(segmentPath)).status, 409)
})
