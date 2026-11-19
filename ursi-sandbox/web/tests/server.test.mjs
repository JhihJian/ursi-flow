import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createConsole } from '../server.mjs'

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return 'http://127.0.0.1:' + server.address().port
}
test('演示与真实配置分离，配置不完整时拒绝启动', async (t) => {
  assert.throws(() => createConsole({ URSI_GATEWAY_URL: 'http://localhost' }))
  const base = await listen(t, createConsole({}))
  assert.deepEqual(await (await fetch(base + '/console-config.json')).json(), {
    mode: 'demo',
  })
  assert.equal((await fetch(base + '/api/v1/sandboxes')).status, 404)
})
test('管理员写请求必须使用白名单路径和同源操作头', async (t) => {
  const calls = []
  const url = await listen(
    t,
    http.createServer((req, res) => {
      calls.push(req.method + ' ' + req.url)
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
  const path = '/api/v1/sandboxes/' + 'a'.repeat(32) + '/stop'
  const post = (p, h) => fetch(base + p, { method: 'POST', headers: h })
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
  assert.deepEqual(calls, ['POST ' + path])
})
test('查看者凭据与 Gateway 凭据独立，只转发列表、详情及日志', async (t) => {
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
  for (const path of [list, item, item + '/logs?tail=200'])
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
    [list, item, item + '/logs?tail=200'].map((path) => [
      path,
      'Bearer ' + key,
    ]),
  )
})
