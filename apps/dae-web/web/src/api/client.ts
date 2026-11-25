import type {
  ConnectionsSnapshot,
  DnsCacheList,
  DnsLogList,
  DnsRuleList,
  FlowList,
  MemoryHistory,
  OutboundsSnapshot,
  RoutingTrace,
  RuleList,
  RuntimeSnapshot,
  TrafficHistory,
  VersionInfo,
} from './types'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface DaeErrorBody {
  error?: { code?: string; message?: string }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as DaeErrorBody | null
    throw new ApiError(body?.error?.message ?? `API ${response.status}`, response.status)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function getVersion(): Promise<VersionInfo> {
  return request('/version')
}

export function getRuntime(): Promise<RuntimeSnapshot> {
  return request('/runtime')
}

export function getOutbounds(): Promise<OutboundsSnapshot> {
  return request('/runtime/outbounds')
}

export function getTrafficHistory(windowSeconds = 120, maxPoints = 120): Promise<TrafficHistory> {
  return request(`/runtime/traffic/history?window_seconds=${windowSeconds}&max_points=${maxPoints}`)
}

export function getMemoryHistory(windowSeconds = 300, maxPoints = 60): Promise<MemoryHistory> {
  return request(`/runtime/memory/history?window_seconds=${windowSeconds}&max_points=${maxPoints}`)
}

export function getConnections(options: {
  windowSeconds?: number
  sort?: string
  type?: 'tcp' | 'udp'
  limit?: number
} = {}): Promise<ConnectionsSnapshot> {
  const params = new URLSearchParams()
  if (options.windowSeconds) params.set('window_seconds', String(options.windowSeconds))
  if (options.sort) params.set('sort', options.sort)
  if (options.type) params.set('type', options.type)
  if (options.limit) params.set('limit', String(options.limit))
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  return request<ConnectionsSnapshot>(`/connections${suffix}`)
}

export function closeConnection(id: string): Promise<void> {
  return request(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function getFlows(limit = 200, cursor?: string | null): Promise<FlowList> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  return request(`/flows?${params.toString()}`)
}

export function getRules(): Promise<RuleList> {
  return request('/rules')
}

export function getDnsRules(): Promise<DnsRuleList> {
  return request('/dns/rules')
}

export function getDnsLog(limit = 200): Promise<DnsLogList> {
  return request(`/dns/log?limit=${limit}`)
}

export function getDnsCache(limit = 200): Promise<DnsCacheList> {
  return request(`/dns/cache?limit=${limit}`)
}

export function deleteDnsCacheEntry(entryId: string): Promise<{ deleted: number }> {
  return request(`/dns/cache/${encodeURIComponent(entryId)}`, { method: 'DELETE' })
}

export function flushDnsCache(): Promise<{ deleted: number }> {
  return request('/dns/cache/flush', { method: 'POST', body: '{}' })
}

export interface TraceInput {
  network: 'tcp' | 'udp'
  dstIp?: string | null
  dstPort: number
  srcIp?: string | null
  srcPort?: number | null
  domain?: string | null
  pname?: string | null
}

export function traceRouting(input: TraceInput): Promise<RoutingTrace> {
  return request('/routing/trace', {
    method: 'POST',
    body: JSON.stringify({
      resolve: 'none',
      input: {
        network: input.network,
        dst_ip: input.dstIp ?? null,
        dst_port: input.dstPort,
        src_ip: input.srcIp ?? null,
        src_port: input.srcPort ?? null,
        domain: input.domain ?? null,
        pname: input.pname ?? null,
      },
    }),
  })
}
