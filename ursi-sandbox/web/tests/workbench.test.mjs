import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { WebSocket, WebSocketServer } from 'ws'
import { createConsole } from '../server.mjs'

const id = 'a'.repeat(32)
const path = `/api/v1/sandboxes/${id}`
const workbench = `${path}/workbench/1`
const key = 'test-only-gateway-key'
const admin = 'test-only-admin-password'
const view = 'test-only-viewer-password'
const auth = (user, password) => 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

function sshKeys(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'ursi-web-ssh-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  for (const name of ['host', 'wrong-host', 'agent']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(tmp, name)])
  const fingerprint = execFileSync('ssh-keygen', ['-lf', join(tmp, 'host.pub')], { encoding: 'utf8' }).split(' ')[1]
  writeFileSync(join(tmp, 'pins.json'), JSON.stringify({ [id]: fingerprint }))
  return { tmp, env: { URSI_WEB_SSH_KEY_FILE: join(tmp, 'agent'), URSI_WEB_SSH_HOST_PINS_FILE: join(tmp, 'pins.json') } }
}

async function fixture(t, env = {}) {
  const sockets = new Set()
  const servers = []
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    return Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  })
  const start = async (server) => {
    servers.push(server)
    const listener = server instanceof ssh2.Server ? server._srv : server
    listener.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    return listen(server)
  }
  const targets = new Map(), calls = [], navigations = []
  const row = {
    id, status: 'running', operation: null, resource: { generation: 1 }, endpoints: [],
  }
  const endpoint = (name, protocol, port) => row.endpoints.push({ name, protocol, port, ready: true })
  const gateway = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + key)
    calls.push(req.url)
    res.end(JSON.stringify(row))
  })
  const bridge = new WebSocketServer({ noServer: true })
  gateway.on('upgrade', (req, socket, head) => {
    assert.equal(req.headers.authorization, 'Bearer ' + key)
    assert.equal(req.headers.origin, undefined)
    assert.equal(req.headers['sec-websocket-protocol'], 'ursi-tcp-v1')
    assert.equal(req.headers['x-ursi-generation'], '1')
    calls.push(req.url)
    const port = targets.get(req.url.split('/').at(-1))
    if (!port) return socket.destroy()
    const tcp = net.connect(port, '127.0.0.1')
    tcp.on('error', () => socket.destroy())
    tcp.once('connect', () => bridge.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => tcp.destroy())
      ws.once('close', () => tcp.destroy())
      ws.on('message', (data, binary) => binary ? tcp.write(data) : tcp.end())
      tcp.on('data', (data) => {
        for (let i = 0; i < data.length; i += 32 * 1024) ws.send(data.subarray(i, i + 32 * 1024))
      })
      tcp.once('end', () => { ws.send('eof'); ws.close() })
      tcp.once('close', () => ws.close())
    }))
  })
  const G = await start(gateway)
  const consoleServer = createConsole({
    URSI_GATEWAY_URL: `http://127.0.0.1:${G}`, URSI_GATEWAY_KEY: key,
    URSI_WEB_ADMIN_PASSWORD: admin, URSI_WEB_PASSWORD: view, ...env,
  })
  const base = `http://127.0.0.1:${await start(consoleServer)}`
  const connect = (route, headers = { Origin: base, Authorization: auth('admin', admin) }) =>
    new WebSocket(base.replace('http:', 'ws:') + route, { headers, handshakeTimeout: 5000 })
  return { base, calls, connect, start, targets, endpoint, row, navigations }
}

async function status(ws) {
  ws.on('error', () => {})
  const [, res] = await once(ws, 'unexpected-response')
  res.resume()
  ws.terminate()
  return res.statusCode
}

test('workbench 权限、来源、实例代际和逻辑端点限制', { timeout: 6000 }, async (t) => {
  const f = await fixture(t)
  assert.equal(await status(f.connect(workbench + '/desktop', {})), 403)
  assert.equal(await status(f.connect(workbench + '/desktop', { Origin: f.base, Authorization: auth('viewer', view) })), 403)
  for (const origin of [undefined, 'null', f.base.replace('http:', 'https:')])
    assert.equal(await status(f.connect(workbench + '/desktop', { ...(origin ? { Origin: origin } : {}), Authorization: auth('admin', admin) })), 403)
  assert.equal(await status(f.connect(path + '/proxy/cdp/json/version')), 404)
  assert.equal(await status(f.connect(workbench + '/terminal')), 404)
  assert.equal(f.calls.length, 0)
  assert.equal(await status(f.connect(`${path}/workbench/2/desktop`)), 409)
  assert.equal(await status(f.connect(workbench + '/desktop')), 409)
  assert.equal(await status(f.connect(workbench + '/preview/cdp')), 404)
  f.endpoint('desktop', 'websocket', 6080)
  f.endpoint('cdp', 'http', 9222)
  assert.equal(await status(f.connect(workbench + '/preview/cdp')), 404)
  assert.equal(await status(f.connect(workbench + '/preview/unregistered')), 404)
  f.row.status = 'stopped'
  assert.equal(await status(f.connect(workbench + '/desktop')), 409)
  assert.ok(f.calls.every((url) => url === path))
  const res = await fetch(f.base + path + '/proxy/cdp/json/version', { headers: { Authorization: auth('admin', admin) } })
  assert.equal(res.status, 404)
})

test('桌面完成内层 WebSocket 握手，IDE 和应用只在沙箱 Chromium 导航', { timeout: 10000 }, async (t) => {
  const { tmp, env } = sshKeys(t)
  const f = await fixture(t, env)
  f.endpoint('desktop', 'websocket', 6080)
  f.endpoint('ssh', 'ssh', 2222)
  f.endpoint('cdp', 'http', 9222)
  f.endpoint('ide', 'http', 8744)
  f.endpoint('docs', 'http', 8080)
  const under = http.createServer()
  const remote = new WebSocketServer({ server: under })
  let closed = 0
  remote.on('connection', (socket, req) => {
    assert.equal(req.url, '/websockify')
    assert.equal(req.headers.authorization, undefined)
    socket.once('close', () => closed++)
    socket.send(Buffer.from('RFB 003.008\n'))
    socket.on('message', (msg) => socket.send(msg))
  })
  f.targets.set('desktop', await f.start(under))
  f.targets.set('ssh', await f.start(new ssh2.Server({ hostKeys: [readFileSync(join(tmp, 'host'))] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => ctx.username === 'agent' && ctx.method === 'publickey' ? ctx.accept() : ctx.reject())
    client.on('session', (accept) => accept().on('exec', (ok, _no, info) => {
      f.navigations.push(decodeURIComponent(info.command.split("-X PUT '")[1].slice(0, -1)))
      const channel = ok()
      channel.exit(0)
      channel.end()
    }))
  })))
  assert.equal(await status(f.connect(workbench + '/preview/cdp')), 409)
  assert.equal(await status(f.connect(workbench + '/preview/unregistered')), 409)
  for (const name of ['desktop', 'ide', 'preview/docs']) {
    const ws = f.connect(workbench + '/' + name)
    const [greeting, binary] = await once(ws, 'message')
    assert.ok(binary)
    assert.equal(greeting.toString(), 'RFB 003.008\n')
    ws.send(Buffer.from('control'))
    assert.equal((await once(ws, 'message'))[0].toString(), 'control')
    ws.close()
    await once(ws, 'close')
  }
  assert.deepEqual(f.navigations, [
    'http://127.0.0.1:9222/json/new?http://127.0.0.1:8744/',
    'http://127.0.0.1:9222/json/new?http://127.0.0.1:8080/',
  ])
  assert.ok(!f.calls.includes(`${path}/connect/cdp`))
  for (let n = 0; n < 40 && closed < 3; n++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(closed, 3)
})

test('SSH2 主机指纹验证、双向 PTY 字节和缩放', { timeout: 10000 }, async (t) => {
  const { tmp, env } = sshKeys(t)
  const f = await fixture(t, env)
  const pties = [], sizes = []
  const sshServer = (name) => new ssh2.Server({ hostKeys: [readFileSync(join(tmp, name))] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => ctx.username === 'agent' && ctx.method === 'publickey' ? ctx.accept() : ctx.reject())
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (ok, _no, pty) => { pties.push(pty.term); ok() })
      session.on('window-change', (ok, _no, size) => { sizes.push([size.cols, size.rows]); ok?.() })
      session.on('shell', (ok) => { const channel = ok(); channel.on('data', (data) => channel.write(data)) })
    })
  })
  f.endpoint('ssh', 'ssh', 2222)
  f.targets.set('ssh', await f.start(sshServer('wrong-host')))
  assert.equal(await status(f.connect(workbench + '/terminal')), 502)
  f.targets.set('ssh', await f.start(sshServer('host')))
  const ws = f.connect(workbench + '/terminal')
  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 27 }))
  ws.send(JSON.stringify({ type: 'input', data: '你好\r' }))
  const [data, binary] = await once(ws, 'message')
  assert.equal(binary, true)
  assert.equal(data.toString(), '你好\r')
  assert.deepEqual(pties, ['xterm-256color'])
  assert.deepEqual(sizes, [[100, 27]])
  ws.send(JSON.stringify({ type: 'resize', cols: 999, rows: 27 }))
  assert.equal((await once(ws, 'close'))[0], 1008)
})
