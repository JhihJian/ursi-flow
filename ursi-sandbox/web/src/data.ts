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
    address: string
    port: number
    visibility: string
  }[]
  error: string | null
}
type Read<T> = T | Promise<T>
export interface Source {
  demo: boolean
  list: (signal: AbortSignal) => Read<Sandbox[]>
  detail: (id: string, signal: AbortSignal) => Read<Sandbox>
  logs: (id: string, signal: AbortSignal) => Read<string>
}
async function json<T>(path: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(path, { signal, cache: 'no-store' })
  const errors: Record<number, string> = {
    401: '身份验证失败',
    403: '无权访问',
    404: '资源不存在',
    502: 'Gateway 连接失败',
    503: 'Gateway 暂不可用',
  }
  if (!r.ok) throw new Error(errors[r.status] || `请求失败（HTTP ${r.status}）`)
  return r.json()
}
export async function loadSource(signal: AbortSignal): Promise<Source> {
  const { mode } = await json<{ mode: string }>('./console-config.json', signal)
  if (mode === 'demo') {
    const { rows } = await import('./demo')
    const item = (id: string) => {
      const row = rows.find((r) => r.id === id)
      if (!row) throw new Error('沙箱不存在')
      return row
    }
    return {
      demo: true,
      list: () => rows,
      detail: item,
      logs: (id) =>
        `[demo] ${item(id).spec.labels.name}\n[status] ${item(id).error || item(id).status}`,
    }
  }
  if (mode !== 'gateway') throw new Error('数据源配置无效')
  const base = './api/v1/sandboxes'
  return {
    demo: false,
    list: async (s) =>
      (await json<{ sandboxes: Sandbox[] }>(base, s)).sandboxes,
    detail: (id, s) => json<Sandbox>(`${base}/${encodeURIComponent(id)}`, s),
    logs: async (id, s) =>
      (
        await json<{ content: string }>(
          `${base}/${encodeURIComponent(id)}/logs?tail=200`,
          s,
        )
      ).content,
  }
}
