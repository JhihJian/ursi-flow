// 本地预览服务：静态托管 dist 并模拟 Gateway API，无需真实沙箱环境。
// 用法：npm run build && node preview-server.mjs，打开 http://127.0.0.1:14482/dist/
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const port = 14482
const dist = '/dist'

const now = Date.now()
const HOUR = 3600_000
const uuidOf = (n) => String(n).padStart(8, '0').repeat(4)
const SBX_A = '1'.repeat(32)
const SBX_B = '2'.repeat(32)
const SBX_C = '3'.repeat(32)
const SBX_D = '4'.repeat(32)

const sandboxes = [
  {
    id: SBX_A,
    status: 'running',
    spec: {
      image: 'alpine:3.22',
      labels: { name: 'web-demo', profile: 'default' },
      cpus: 1,
      memory_mb: 256,
      runtime_profile: 'default',
    },
    revision: 3,
    resource: { generation: 7, data_generation: 3 },
    operation: null,
    error: null,
    endpoints: [
      { name: 'ssh', bundle: 'ssh', protocol: 'ssh', port: 2222, state: 'ready', ready: true },
      { name: 'desktop', bundle: 'pi', protocol: 'websocket', port: 6080, state: 'ready', ready: true },
      { name: 'ide', bundle: 'pi', protocol: 'http', port: 8443, state: 'ready', ready: true },
      { name: 'webapp', bundle: 'pi', protocol: 'http', port: 8080, state: 'ready', ready: true },
    ],
  },
  {
    id: SBX_B,
    status: 'running',
    spec: {
      image: 'ubuntu:24.04',
      labels: { name: 'build-agent', profile: 'default' },
      cpus: 4,
      memory_mb: 4096,
      runtime_profile: 'default',
    },
    revision: 2,
    resource: { generation: 4, data_generation: 2 },
    operation: null,
    error: null,
    endpoints: [
      { name: 'ssh', bundle: 'ssh', protocol: 'ssh', port: 2222, state: 'ready', ready: true },
    ],
  },
  {
    id: SBX_C,
    status: 'stopped',
    spec: {
      image: 'alpine:3.22',
      labels: { name: 'nightly-job', profile: 'default' },
      cpus: 1,
      memory_mb: 512,
      runtime_profile: 'default',
    },
    revision: 1,
    resource: { generation: 2, data_generation: 1 },
    operation: null,
    error: null,
    endpoints: [],
  },
  {
    id: SBX_D,
    status: 'running',
    spec: {
      image: 'alpine:3.19',
      labels: { name: 'legacy-ssh' },
      cpus: 1,
      memory_mb: 256,
      runtime_profile: null,
    },
    revision: 5,
    resource: { generation: 9, data_generation: 2 },
    operation: { kind: 'start' },
    error: null,
    endpoints: [
      { name: 'ssh', bundle: 'ssh', protocol: 'ssh', port: 2222, state: 'ready', ready: true },
    ],
  },
]

const registry = {
  bundles: {
    ssh: {
      version: '1.4.0',
      endpoints: [{ name: 'ssh', protocol: 'ssh', port: 22 }],
      services: ['sshd'],
    },
    pi: {
      version: '2.1.0',
      runtime: {
        url: 'https://example.invalid/pi.tar.zst',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        min_image_level: 1,
      },
      endpoints: [
        { name: 'desktop', protocol: 'websocket', port: 6080 },
        { name: 'ide', protocol: 'http', port: 8443 },
        { name: 'cdp', protocol: 'http', port: 9222 },
        { name: 'cdp-http', protocol: 'http', port: 9223 },
      ],
      services: ['novnc', 'code-server', 'chromium'],
      requires: ['sshd'],
    },
    browser: {
      version: '1.0.3',
      endpoints: [
        { name: 'desktop', protocol: 'websocket', port: 6080 },
        { name: 'cdp', protocol: 'http', port: 9222 },
        { name: 'cdp-http', protocol: 'http', port: 9223 },
      ],
      services: ['chromium'],
    },
  },
  images: {
    'alpine:3.22': ['ssh', 'pi'],
    'alpine:3.19': ['ssh'],
    'ubuntu:24.04': ['ssh'],
    'debian:12': ['ssh', 'pi', 'browser'],
    'mcr.microsoft.com/playwright:v1.49.0': ['browser'],
  },
}

const images = {
  inventory: 'available',
  images: Object.entries(registry.images).map(([reference, bundles]) => ({
    reference,
    local_id: 'sha256:' + reference.length.toString(16).padStart(12, '0'),
    registered: { bundles, endpoints: [], runtime_min_image_level: null },
  })),
}

const accessReport = {
  profiles: [
    {
      profile: 'default',
      rendered_at: now - 2 * HOUR,
      keys: [
        {
          key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4demo demo@ursi',
          fingerprint: 'SHA256:DemoF1ngerpr1ntDemoF1ngerpr1ntDemo',
          created_at: now - 26 * HOUR,
        },
        {
          key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICiolder older@ursi',
          fingerprint: 'SHA256:0lderF1ngerpr1nt0lderF1ngerpr1nt0lderDemo',
          created_at: now - 30 * 24 * HOUR,
        },
      ],
      sandboxes: [
        { id: SBX_A, status: 'running', generation: 7, attached: true },
        { id: SBX_B, status: 'running', generation: 4, attached: false },
        { id: SBX_C, status: 'stopped', generation: 2, attached: null },
      ],
    },
  ],
}

const accessProbeConfigured = {
  configured: true,
  public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4demo demo@ursi',
  fingerprint: 'SHA256:DemoF1ngerpr1ntDemoF1ngerpr1ntDemo',
}

let registryOverrides = null

// 标准以太网 + UDP pcap，供分段预览解析。
function pcapSegment(packets) {
  const head = Buffer.alloc(24)
  head.writeUInt32LE(0xa1b2c3d4, 0)
  head.writeUInt16LE(2, 4)
  head.writeUInt16LE(4, 6)
  head.writeUInt32LE(65535, 16)
  head.writeUInt32LE(1, 20) // LINKTYPE_ETHERNET
  const chunks = [head]
  let t = 0
  for (const payload of packets) {
    const rec = Buffer.alloc(16)
    rec.writeUInt32LE(t, 0)
    t += 2
    rec.writeUInt32LE(payload.length, 8)
    rec.writeUInt32LE(payload.length, 12)
    chunks.push(rec, payload)
  }
  return Buffer.concat(chunks)
}
function udpPacket(srcIp, dstIp, sport, dport, payloadLen) {
  const eth = Buffer.alloc(14)
  eth[12] = 0x08
  eth[13] = 0x00 // IPv4
  const ip = Buffer.alloc(20)
  ip[0] = 0x45
  ip[4] = 0
  ip[8] = 64
  ip[9] = 17 // UDP
  srcIp.split('.').forEach((x, i) => (ip[12 + i] = Number(x)))
  dstIp.split('.').forEach((x, i) => (ip[16 + i] = Number(x)))
  const udp = Buffer.alloc(8)
  udp.writeUInt16BE(sport, 0)
  udp.writeUInt16BE(dport, 2)
  udp.writeUInt16BE(8 + payloadLen, 4)
  return Buffer.concat([eth, ip, udp, Buffer.alloc(payloadLen, 0x41)])
}
const segmentPcap = pcapSegment([
  udpPacket('10.0.0.2', '10.0.0.3', 50000, 53, 18),
  udpPacket('10.0.0.3', '10.0.0.2', 53, 50000, 96),
  udpPacket('10.0.0.2', '8.8.8.8', 51000, 53, 32),
  udpPacket('8.8.8.8', '10.0.0.2', 53, 51000, 172),
  udpPacket('10.0.0.2', '10.0.0.1', 52000, 123, 48),
  udpPacket('10.0.0.1', '10.0.0.2', 123, 52000, 48),
])

const obs = {
  observation_id: uuidOf(42),
  sandbox_id: SBX_A,
  generation: 7,
  started_ms: now - 40 * 60_000,
  ended_ms: null,
  state: 'running',
  reason: null,
  error: null,
  packets: 128452,
  bytes: 96_337_408,
  segments: 3,
  kernel_drops: 12,
  queue_drops: 0,
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res, status, body, headers = {}) {
  const data =
    typeof body === 'string' || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(data)
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const p = u.pathname
  try {
    if (p === dist + '/console-config.json')
      return send(res, 200, {
        mode: 'gateway',
        manage: true,
        sshSandboxes: [SBX_A, SBX_B, SBX_D],
      })
    if (p === dist + '/api/v1/capabilities')
      return send(res, 200, {
        tunnel_enabled: true,
        observer_enabled: true,
        capabilities: {
          rebuild_preserve_data: true,
          rebuild_destroy_data: true,
          access_keys: true,
        },
      })
    if (p === dist + '/api/v1/sandboxes' && req.method === 'GET')
      return send(res, 200, { sandboxes })
    if (p === dist + '/api/v1/sandboxes' && req.method === 'POST') {
      const spec = await readBody(req)
      const row = {
        id: randomBytes(16).toString('hex'),
        status: 'running',
        spec: {
          image: typeof spec?.image === 'string' ? spec.image : 'alpine:3.22',
          labels: spec?.labels ?? {},
          cpus: spec?.cpus ?? 1,
          memory_mb: spec?.memory_mb ?? 256,
          runtime_profile: spec?.runtime_profile ?? null,
        },
        revision: 1,
        resource: { generation: 1, data_generation: 1 },
        operation: null,
        error: null,
        endpoints: [
          {
            name: 'ssh',
            bundle: 'ssh',
            protocol: 'ssh',
            port: 2222,
            state: 'ready',
            ready: true,
          },
        ],
      }
      sandboxes.push(row)
      return send(res, 200, row)
    }
    const mSbx = p.match(/^\/dist\/api\/v1\/sandboxes\/([0-9a-f]{32})$/)
    if (mSbx) {
      const row = sandboxes.find((s) => s.id === mSbx[1])
      if (!row) return send(res, 404, { error: { message: '资源不存在' } })
      if (req.method === 'GET') return send(res, 200, row)
      if (req.method === 'DELETE') {
        const index = sandboxes.findIndex((s) => s.id === mSbx[1])
        if (index >= 0) sandboxes.splice(index, 1)
        return send(res, 200, row)
      }
    }
    const mAction = p.match(
      /^\/dist\/api\/v1\/sandboxes\/([0-9a-f]{32})\/(start|stop|rebuild)$/,
    )
    if (mAction && req.method === 'POST') {
      const row = sandboxes.find((s) => s.id === mAction[1])
      if (!row) return send(res, 404, { error: { message: '资源不存在' } })
      if (mAction[2] === 'start') row.status = 'running'
      else if (mAction[2] === 'stop') row.status = 'stopped'
      else if (mAction[2] === 'rebuild') {
        row.resource.generation += 1
        row.status = 'running'
      }
      row.operation = null
      return send(res, 200, row)
    }
    const mLogs = p.match(
      /^\/dist\/api\/v1\/sandboxes\/([0-9a-f]{32})\/logs/,
    )
    if (mLogs)
      return send(res, 200, {
        content: [
          '[00:00:01.204] container: starting alpine:3.22',
          '[00:00:01.512] runtime: bundle ssh 1.4.0 attached (endpoint ssh/2222)',
          '[00:00:02.008] runtime: bundle pi 2.1.0 attached (desktop/6080 ide/8443 webapp/8080)',
          '[00:00:02.313] endpoint: webapp ready',
          '[00:00:03.772] gateway: tunnel established',
          '[00:00:41.100] observation: segment 2 opened',
          '[00:12:00.000] healthcheck: ok (rtt 1.2ms)',
        ].join('\n'),
      })
    const mObs = p.match(
      /^\/dist\/api\/v1\/sandboxes\/([0-9a-f]{32})\/observations$/,
    )
    if (mObs && req.method === 'POST') {
      obs.started_ms = Date.now() - 40 * 60_000
      return send(res, 200, obs)
    }
    const mRun = p.match(
      /^\/dist\/api\/v1\/sandboxes\/([0-9a-f]{32})\/observations\/([0-9a-f-]{36})$/,
    )
    if (mRun && req.method === 'GET') {
      obs.packets += 137
      obs.bytes += 91_102
      return send(res, 200, obs)
    }
    if (mRun && req.method === 'POST')
      return send(res, 200, {
        ...obs,
        ended_ms: Date.now(),
        state: 'stopped',
        reason: 'requested',
      })
    const mSeg = p.match(
      /^\/dist\/api\/v1\/sandboxes\/([0-9a-f]{32})\/observations\/([0-9a-f-]{36})\/segments\/(\d+)$/,
    )
    if (mSeg)
      return send(res, 200, segmentPcap, {
        'Content-Type': 'application/vnd.tcpdump.pcap',
      })
    if (p === dist + '/api/v1/access-keys' && req.method === 'GET')
      return send(res, 200, accessReport)
    if (p === dist + '/api/v1/access-keys' && req.method === 'POST') {
      const { profile, key } = await readBody(req)
      const prof = accessReport.profiles.find((x) => x.profile === profile)
      if (!prof) return send(res, 404, { error: { message: '资源不存在' } })
      prof.rendered_at = null
      prof.keys.push({
        key,
        fingerprint:
          'SHA256:' +
          Buffer.from(key).toString('base64').slice(0, 27).replace(/[+/=]/g, 'x'),
        created_at: Date.now(),
      })
      return send(res, 200, accessReport)
    }
    if (p === dist + '/api/v1/access-keys' && req.method === 'DELETE') {
      const prof = accessReport.profiles[0]
      prof.rendered_at = null
      prof.keys = prof.keys.filter(
        (k) => k.fingerprint !== u.searchParams.get('fingerprint'),
      )
      return send(res, 200, accessReport)
    }
    if (p === dist + '/access/probe' && req.method === 'GET')
      return send(res, 200, accessProbeConfigured)
    if (p === dist + '/access/probe' && req.method === 'POST')
      return send(res, 200, {
        ok: true,
        ms: 12,
        host_fingerprint: 'SHA256:DemoF1ngerpr1ntDemoF1ngerpr1ntDemo',
        probe_fingerprint: 'SHA256:DemoF1ngerpr1ntDemoF1ngerpr1ntDemo',
      })
    if (p === dist + '/api/v1/images') return send(res, 200, images)
    if (p === dist + '/api/v1/registry' && req.method === 'GET')
      return send(res, 200, registryOverrides ?? registry)
    if (p === dist + '/api/v1/registry' && req.method === 'PUT') {
      registryOverrides = await readBody(req)
      return send(res, 200, registryOverrides)
    }
    // 静态文件：仅允许 dist 内路径，其余回落 index.html（SPA 深链）。
    const rel = path.normalize(p.slice(dist.length)).replace(/^([/\\])+/, '')
    const file = path.join(root, rel === '' ? 'index.html' : rel)
    if (existsSync(file) && path.resolve(file).startsWith(root)) {
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.svg': 'image/svg+xml',
      }
      return send(res, 200, await readFile(file), {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      })
    }
    return send(res, 200, await readFile(path.join(root, 'index.html')), {
      'Content-Type': 'text/html; charset=utf-8',
    })
  } catch (e) {
    send(res, 500, { error: { message: String(e) } })
  }
})

server.listen(port, '0.0.0.0', () =>
  console.log(`沙箱控制台预览: http://127.0.0.1:${port}${dist}/`),
)
