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
    { mode: 'gateway' },
  )
  for (const path of [list, item, item + '/logs?tail=200'])
    assert.equal((await fetch(base + path, { headers })).status, 200)
  assert.equal(
    (await fetch(base + item, { method: 'DELETE', headers })).status,
    405,
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
