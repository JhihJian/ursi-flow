import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Duplex } from 'node:stream'
import { Client } from 'ssh2'
import { WebSocket, WebSocketServer } from 'ws'

const route = /^\/api\/v1\/sandboxes\/([a-f0-9]{32})\/workbench\/([1-9]\d*)\/(terminal|desktop|ide|preview\/([a-zA-Z0-9_-]{1,64}))$/
const maxBuffered = 4 * 1024 * 1024
const timeout = 8000

function opened(ws) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(Error('WebSocket unavailable'))
    ws.on('error', fail)
    ws.once('close', fail)
    ws.once('open', () => {
      ws.off('close', fail)
      resolve(ws)
    })
  })
}

// Translate the Gateway's binary frames and directional EOF into a byte stream.
function tunnel(ws, signal) {
  let ended = false
  const stream = new Duplex({
    allowHalfOpen: true,
    read() { ws.resume() },
    write(chunk, _encoding, done) {
      let offset = 0
      const send = (error) => {
        if (error || offset === chunk.length) return done(error)
        const next = chunk.subarray(offset, offset + 64 * 1024)
        offset += next.length
        ws.send(next, { binary: true }, send)
      }
      send()
    },
    final(done) { ws.send('eof', done) },
    destroy(error, done) {
      signal.removeEventListener('abort', cancel)
      ws.terminate()
      done(error)
    },
  })
  const cancel = () => stream.destroy()
  stream.on('error', () => {})
  ws.on('error', (error) => stream.destroy(error))
  ws.on('close', () => {
    if (!ended) stream.destroy(Error('Gateway tunnel closed'))
    else if (!stream.writableEnded) stream.end()
  })
  ws.on('message', (data, binary) => {
    if (ended) return stream.destroy(Error('Gateway sent data after EOF'))
    if (binary) {
      if (!stream.push(data)) ws.pause()
    } else if (data.toString() === 'eof') {
      ended = true
      stream.push(null)
    } else stream.destroy(Error('Invalid Gateway frame'))
  })
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  return stream
}

function sshSettings(env) {
  const key = env.URSI_WEB_SSH_KEY_FILE
  const hosts = env.URSI_WEB_SSH_HOST_PINS_FILE
  if (!key && !hosts) return null
  if (!key || !hosts) throw Error('Web SSH 需要同时配置私钥和主机指纹文件')
  const pins = JSON.parse(readFileSync(hosts, 'utf8'))
  if (!pins || typeof pins !== 'object' || Array.isArray(pins) ||
    !Object.entries(pins).every(([id, pin]) => /^[a-f0-9]{32}$/.test(id) && typeof pin === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(pin)))
    throw Error('Web SSH 主机指纹文件格式无效')
  return { privateKey: readFileSync(key), pins }
}

function openSsh(stream, options, pin) {
  return new Promise((resolve, reject) => {
    const ssh = new Client()
    const fail = () => reject(Error('SSH session unavailable'))
    stream.once('close', () => { ssh.destroy(); fail() })
    ssh.on('error', fail)
    ssh.once('close', fail)
    ssh.once('ready', () => resolve(ssh))
    ssh.connect({
      sock: stream,
      username: 'agent',
      privateKey: options.privateKey,
      readyTimeout: timeout,
      hostVerifier: (key) => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=$/, '') === pin,
    })
  })
}

function sshChannel(ssh, start) {
  return new Promise((resolve, reject) => {
    const closed = () => reject(Error('SSH session closed'))
    ssh.once('close', closed)
    start((error, channel) => {
      ssh.off('close', closed)
      if (error) return reject(error)
      channel.on('error', () => ssh.destroy())
      resolve(channel)
    })
  })
}

function send(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return
  if (ws.bufferedAmount > maxBuffered) return ws.terminate()
  ws.send(data, { binary: true }, (error) => { if (error) ws.terminate() })
}

function relayTerminal(browser, shell, stream) {
  shell.on('data', (data) => send(browser, data))
  shell.stderr.on('data', (data) => send(browser, data))
  shell.once('close', () => browser.close())
  stream.once('close', () => browser.close())
  browser.on('message', (data, binary) => {
    if (binary || data.length > 64 * 1024) return browser.close(1008)
    try {
      const message = JSON.parse(data.toString())
      if (message?.type === 'input' && typeof message.data === 'string') {
        if (shell.writableLength > maxBuffered) return browser.close(1008)
        shell.write(message.data)
      } else if (message?.type === 'resize' && [message.cols, message.rows].every((n) => Number.isInteger(n) && n > 0 && n <= 500)) {
        shell.setWindow(message.rows, message.cols, 0, 0)
      } else browser.close(1008)
    } catch { browser.close(1008) }
  })
}

async function cdpNavigation(ssh, targetPort) {
  // CDP stays on guest loopback. Only the validated numeric registry port
  // enters this fixed command. No arbitrary URL or command comes from the Web.
  const target = encodeURIComponent(`http://127.0.0.1:${targetPort}/`)
  const command = `/usr/bin/curl -q -fsS --noproxy '*' --max-time 5 -o /dev/null -X PUT 'http://127.0.0.1:9222/json/new?${target}'`
  const channel = await sshChannel(ssh, (done) => ssh.exec(command, done))
  await new Promise((resolve, reject) => {
    channel.once('close', (code) => code === 0 ? resolve() : reject(Error('CDP navigation failed')))
    channel.resume()
    channel.stderr.resume()
  })
}

export function attachWorkbench(server, { env, url, key, isAdmin }) {
  const external = env.URSI_WEB_ORIGIN && new URL(env.URSI_WEB_ORIGIN)
  if (external && (!/^https?:$/.test(external.protocol) || external.origin !== env.URSI_WEB_ORIGIN))
    throw Error('URSI_WEB_ORIGIN 必须是完整的 HTTP(S) origin')
  const ssh = url ? sshSettings(env) : null
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  let active = 0
  const gateway = async (id, generation, endpoint, signal) => {
    const target = new URL(`/api/v1/sandboxes/${id}/connect/${endpoint}`, url)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(target, 'ursi-tcp-v1', {
      headers: { Authorization: `Bearer ${key}`, 'X-Ursi-Generation': generation },
      handshakeTimeout: timeout,
      maxPayload: 64 * 1024,
    })
    const bytes = tunnel(ws, signal)
    try { await opened(ws); return bytes } catch (e) { bytes.destroy(); throw e }
  }
  server.on('upgrade', async (req, socket, head) => {
    const reject = (status) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    const match = route.exec(req.url || '')
    if (!url || !match) return reject('404 Not Found')
    if (!isAdmin(req)) return reject('403 Forbidden')
    const actual = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`
    const expected = external?.origin || actual
    if (req.headers.origin !== expected || (external && req.headers.host !== external.host)) return reject('403 Forbidden')
    if (active >= 32) return reject('503 Service Unavailable')
    const [, id, generation, mode, preview] = match
    if (mode !== 'desktop' && !ssh?.pins[id]) return reject('404 Not Found')
    active++
    const ctrl = new AbortController()
    socket.once('error', () => socket.destroy())
    socket.once('close', () => { active--; ctrl.abort() })
    const timer = setTimeout(() => { reject('504 Gateway Timeout'); ctrl.abort() }, 20000)
    const upgrade = (accept) => {
      if (ctrl.signal.aborted) return
      sockets.handleUpgrade(req, socket, head, (browser) => {
        browser.on('error', () => browser.terminate())
        browser.once('close', () => ctrl.abort())
        accept(browser)
      })
    }
    try {
      const response = await fetch(new URL(`/api/v1/sandboxes/${id}`, url), {
        headers: { Authorization: `Bearer ${key}` },
        redirect: 'error', signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(timeout)]),
      })
      if (!response.ok) return reject(response.status === 404 ? '404 Not Found' : '502 Bad Gateway')
      const row = await response.json()
      if (row.id !== id || String(row.resource?.generation) !== generation || row.status !== 'running' || row.operation)
        return reject('409 Conflict')
      const endpoint = (name, protocol) => row.endpoints?.find((e) => e.name === name && e.protocol === protocol && e.ready === true && Number.isInteger(e.port) && e.port > 0 && e.port <= 65535)
      const connect = (name) => gateway(id, generation, name, ctrl.signal)
      if (mode !== 'desktop' && !endpoint('ssh', 'ssh')) return reject('409 Conflict')
      if (mode === 'terminal') {
        const bytes = await connect('ssh')
        const client = await openSsh(bytes, ssh, ssh.pins[id])
        const shell = await sshChannel(client, (done) => client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, done))
        return upgrade((browser) => relayTerminal(browser, shell, bytes))
      }
      const desktop = endpoint('desktop', 'websocket')
      const target = mode === 'ide' ? endpoint('ide', 'http') : preview && !['ide', 'cdp'].includes(preview) ? endpoint(preview, 'http') : null
      if (!desktop || (mode !== 'desktop' && !target)) return reject('409 Conflict')
      const bytes = await connect('desktop')
      const remote = new WebSocket(`ws://127.0.0.1:${desktop.port}/websockify`, ['binary'], {
        createConnection: () => bytes, handshakeTimeout: timeout, maxPayload: 1024 * 1024,
      })
      bytes.once('close', () => remote.terminate())
      // Buffer nothing until the browser handshake; pausing retains the RFB greeting.
      remote.once('open', () => remote.pause())
      await opened(remote)
      if (target) {
        const sshBytes = await connect('ssh')
        try { await cdpNavigation(await openSsh(sshBytes, ssh, ssh.pins[id]), target.port) }
        finally { sshBytes.destroy() }
      }
      upgrade((browser) => {
        if (remote.readyState !== WebSocket.OPEN) return browser.close(1011)
        remote.on('message', (data, binary) => { if (binary) send(browser, data); else browser.close(1008) })
        remote.once('close', () => browser.close())
        browser.on('message', (data, binary) => { if (binary) send(remote, data); else browser.close(1008) })
        remote.resume()
      })
    } catch {
      if (!ctrl.signal.aborted) reject('502 Bad Gateway')
    } finally { clearTimeout(timer) }
  })
  return { sshSandboxes: Object.keys(ssh?.pins || {}) }
}
