// 接入探活：用控制台自己的 SSH 身份真实登录一次沙箱，端到端证明
// 「公钥已登记 → 已渲染 → 容器已挂载 → sshd 接受 → agent 可执行命令」整条链。
// 它不接触用户的私钥，也不代表某个用户自己的密钥可用。
import { readFileSync } from 'node:fs'
import ssh2 from 'ssh2'
import { WebSocket } from 'ws'
import { fingerprint, openSsh, tunnel } from './workbench.mjs'

const timeout = 8000

/// 控制台探活身份的公钥与指纹。私钥只在服务端使用，公钥可以公开。
export function probeIdentity(env) {
  const key = env.URSI_WEB_SSH_KEY_FILE
  if (!key) return null
  let parsed
  try {
    parsed = ssh2.utils.parseKey(readFileSync(key))
  } catch {
    throw Error('Web SSH 私钥无法解析')
  }
  if (!parsed || parsed instanceof Error) throw Error('Web SSH 私钥无法解析')
  const blob = parsed.getPublicSSH()
  return {
    publicKey: `${parsed.type} ${blob.toString('base64')} ursi-console-probe`,
    fingerprint: fingerprint(blob),
  }
}

function gatewayRequest(url, key, path, signal) {
  return fetch(new URL(path, url), {
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error',
    signal,
  })
}

async function connectTunnel(url, key, id, endpoint, signal) {
  const target = new URL(`/api/v1/sandboxes/${id}/connect/${endpoint}`, url)
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(target, 'ursi-tcp-v1', {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: timeout,
    maxPayload: 64 * 1024,
  })
  const bytes = tunnel(ws, signal)
  await new Promise((resolve, reject) => {
    const fail = () => reject(Error('tunnel_closed'))
    ws.on('error', fail)
    ws.once('close', fail)
    ws.once('open', () => {
      ws.off('close', fail)
      resolve()
    })
  })
  return bytes
}

function execTrue(ssh) {
  return new Promise((resolve, reject) => {
    ssh.exec('true', (error, channel) => {
      if (error) return reject(Error('exec_failed'))
      channel.on('error', () => reject(Error('exec_failed')))
      channel.once('close', (code) => (code === 0 ? resolve() : reject(Error('exec_failed'))))
      channel.resume()
      channel.stderr.resume()
    })
  })
}

/// 返回 {ok:true, host_fingerprint, ms} 或 {ok:false, reason}，不抛出。
export async function probeSandbox({ url, key, privateKey, id, signal }) {
  const started = Date.now()
  const ctrl = new AbortController()
  const cancel = () => ctrl.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const deadline = setTimeout(cancel, timeout + 4000)
  let bytes
  try {
    const response = await gatewayRequest(url, key, `/api/v1/sandboxes/${id}`, AbortSignal.any([ctrl.signal, AbortSignal.timeout(timeout)]))
    if (!response.ok) return { ok: false, reason: response.status === 404 ? 'not_found' : 'gateway_error' }
    const row = await response.json()
    if (row.status !== 'running' || row.operation) return { ok: false, reason: 'not_running' }
    const sshEndpoint = row.endpoints?.find(
      (endpoint) => endpoint.name === 'ssh' && endpoint.protocol === 'ssh' && endpoint.ready === true,
    )
    if (!sshEndpoint) return { ok: false, reason: 'endpoint_not_ready' }

    bytes = await connectTunnel(url, key, id, sshEndpoint.name, ctrl.signal)
    const { ready, observed } = openSsh(bytes, { privateKey }, undefined)
    let ssh
    try {
      ssh = await ready
    } catch (error) {
      const message = String(error?.message || '')
      const reason = /authentication/i.test(message) ? 'auth_failed' : 'ssh_unavailable'
      return { ok: false, reason, host_fingerprint: observed.fingerprint }
    }
    try {
      await execTrue(ssh)
    } catch {
      return { ok: false, reason: 'exec_failed', host_fingerprint: observed.fingerprint }
    } finally {
      ssh.end()
    }
    return { ok: true, host_fingerprint: observed.fingerprint, ms: Date.now() - started }
  } catch {
    return { ok: false, reason: ctrl.signal.aborted ? 'timeout' : 'tunnel_closed' }
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', cancel)
    bytes?.destroy()
  }
}
