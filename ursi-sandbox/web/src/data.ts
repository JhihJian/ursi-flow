export interface Sandbox {
  id: string
  status: string
  spec: {
    image: string
    labels: Record<string, string>
    cpus: number
    memory_mb: number
    runtime_profile: string | null
  }
  revision: number
  resource: { generation: number; data_generation: number }
  operation: { kind: string } | null
  endpoints: {
    name: string
    bundle: string
    protocol: string
    port: number
    state: string
    ready: boolean
  }[]
  error: string | null
}
type Read<T> = T | Promise<T>
export interface Capabilities {
  rebuild_preserve_data: boolean
  rebuild_destroy_data: boolean
  tunnel_enabled: boolean
}
interface GatewayCapabilities {
  capabilities: Omit<Capabilities, 'tunnel_enabled'>
  tunnel_enabled: boolean
}
const defaultCapabilities: Capabilities = {
  rebuild_preserve_data: false,
  rebuild_destroy_data: false,
  tunnel_enabled: false,
}
export interface Source {
  demo: boolean
  manage: boolean
  capabilities: Capabilities
  create?: (spec: unknown, key: string) => Promise<Sandbox>
  action?: (id: string, action: 'start' | 'stop' | 'delete') => Promise<Sandbox>
  rebuild?: (id: string, preserveData: boolean) => Promise<Sandbox>
  list: (signal: AbortSignal) => Read<Sandbox[]>
  detail: (id: string, signal: AbortSignal) => Read<Sandbox>
  logs: (id: string, signal: AbortSignal) => Read<string>
  endpoints: (id: string, signal: AbortSignal) => Read<Sandbox['endpoints']>
}
export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
async function json<T>(
  path: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> {
  const r = await fetch(path, { signal, cache: 'no-store', ...init })
  const errors: Record<number, string> = {
    401: '身份验证失败',
    403: '无权访问',
    404: '资源不存在',
    502: 'Gateway 连接失败',
    503: 'Gateway 暂不可用',
  }
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new GatewayError(
      r.status,
      err?.error?.message || errors[r.status] || `请求失败（HTTP ${r.status}）`,
    )
  }
  return r.json()
}
export async function loadSource(signal: AbortSignal): Promise<Source> {
  const { mode, manage } = await json<{ mode: string; manage?: boolean }>(
    './console-config.json',
    signal,
  )
  if (mode === 'demo') {
    const { rows } = await import('./demo')
    const item = (id: string) => {
      const row = rows.find((r) => r.id === id)
      if (!row) throw new Error('沙箱不存在')
      return row
    }
    return {
      demo: true,
      manage: false,
      capabilities: defaultCapabilities,
      list: () => rows,
      detail: item,
      endpoints: (id) => item(id).endpoints,
      logs: (id) =>
        `[demo] ${item(id).spec.labels.name}\n[status] ${item(id).error || item(id).status}`,
    }
  }
  if (mode !== 'gateway') throw new Error('数据源配置无效')
  const base = './api/v1/sandboxes'
  const gatewayCapabilities = await json<GatewayCapabilities>(
    './api/v1/capabilities',
    signal,
  ).catch(() => null)
  const capabilities = gatewayCapabilities
    ? {
        ...gatewayCapabilities.capabilities,
        tunnel_enabled: gatewayCapabilities.tunnel_enabled,
      }
    : defaultCapabilities
  return {
    demo: false,
    manage: manage === true,
    capabilities,
    create: manage
      ? (spec, key) =>
          json(base, undefined, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Ursi-Action': 'manage',
              'Idempotency-Key': key,
            },
            body: JSON.stringify(spec),
          })
      : undefined,
    action: manage
      ? (id, action) =>
          json(
            `${base}/${encodeURIComponent(id)}${action === 'delete' ? '' : '/' + action}`,
            undefined,
            {
              method: action === 'delete' ? 'DELETE' : 'POST',
              headers: { 'X-Ursi-Action': 'manage' },
            },
          )
      : undefined,
    rebuild: manage
      ? (id, preserveData) =>
          json(`${base}/${encodeURIComponent(id)}/rebuild`, undefined, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Ursi-Action': 'manage',
            },
            body: JSON.stringify({ preserve_data: preserveData }),
          })
      : undefined,
    list: async (s) =>
      (await json<{ sandboxes: Sandbox[] }>(base, s)).sandboxes,
    detail: (id, s) => json<Sandbox>(`${base}/${encodeURIComponent(id)}`, s),
    endpoints: async (id, s) =>
      (await json<Sandbox>(`${base}/${encodeURIComponent(id)}/endpoints`, s))
        .endpoints,
    logs: async (id, s) =>
      (
        await json<{ content: string }>(
          `${base}/${encodeURIComponent(id)}/logs?tail=200`,
          s,
        )
      ).content,
  }
}
