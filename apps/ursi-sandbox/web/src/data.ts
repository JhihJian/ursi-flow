import { apiUrl } from './api-base'

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
export interface Registry {
  bundles: Record<
    string,
    {
      id?: string
      version: string
      runtime?: { url: string; sha256: string; min_image_level: number }
      endpoints: { name: string; protocol: string; port: number }[]
      requires?: string[]
      conflicts?: string[]
      services?: string[]
      readiness?: Record<string, string>
    }
  >
  images: Record<string, string[]>
}
export interface LogicalEndpoint {
  name: string
  protocol: string
  port: number
}
export const runtimeImages = {
  ssh: 'ursi-runtime-ssh:local',
  pi: 'ursi-runtime-pi:local',
  browser: 'ursi-runtime-browser:local',
} as const

export interface ImageInventory {
  inventory: 'available' | 'unavailable' | 'unsupported'
  images: {
    reference: string
    local_id: string | null
    registered: {
      bundles: string[]
      endpoints: (LogicalEndpoint & { bundle: string })[]
      runtime_min_image_level: number | null
    } | { invalid: true } | null
  }[]
}
export interface Capabilities {
  rebuild_preserve_data: boolean
  rebuild_destroy_data: boolean
  access_keys: boolean
  tunnel_enabled: boolean
  observer_enabled: boolean
}
interface GatewayCapabilities {
  capabilities: Omit<Capabilities, 'tunnel_enabled' | 'observer_enabled'>
  observer_enabled: boolean
  tunnel_enabled: boolean
}
const defaultCapabilities: Capabilities = {
  rebuild_preserve_data: false,
  rebuild_destroy_data: false,
  access_keys: false,
  tunnel_enabled: false,
  observer_enabled: false,
}
export interface AccessKey {
  key: string
  fingerprint: string
  created_at: number
}
export interface AccessSandbox {
  id: string
  status: string
  generation: number
  attached: boolean | null
}
export interface ProfileAccess {
  profile: string
  rendered_at: number | null
  keys: AccessKey[]
  sandboxes: AccessSandbox[]
}
export interface AccessReport {
  profiles: ProfileAccess[]
}
export interface ProbeIdentity {
  configured: boolean
  public_key?: string
  fingerprint?: string
  reason?: string
}
export interface ProbeResult {
  ok: boolean
  reason?: string
  host_fingerprint?: string
  probe_fingerprint?: string
  ms?: number
}
export interface Source {
  manage: boolean
  sshSandboxes?: string[]
  capabilities: Capabilities
  create?: (spec: unknown, key: string) => Promise<Sandbox>
  action?: (id: string, action: 'start' | 'stop' | 'delete') => Promise<Sandbox>
  rebuild?: (id: string, preserveData: boolean) => Promise<Sandbox>
  list: (signal: AbortSignal) => Promise<Sandbox[]>
  detail: (id: string, signal: AbortSignal) => Promise<Sandbox>
  logs: (id: string, signal: AbortSignal) => Promise<string>
  images: (signal: AbortSignal) => Promise<ImageInventory>
  registry?: (signal: AbortSignal) => Promise<Registry>
  replaceRegistry?: (registry: Registry) => Promise<Registry>
  accessKeys?: (signal: AbortSignal) => Promise<AccessReport>
  addAccessKey?: (profile: string, key: string) => Promise<AccessReport>
  removeAccessKey?: (profile: string, fingerprint: string) => Promise<AccessReport>
  probeIdentity?: () => Promise<ProbeIdentity>
  probeSandbox?: (sandboxId: string) => Promise<ProbeResult>
}
export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
export async function json<T>(
  path: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> {
  const r = await fetch(apiUrl(path), { signal, cache: 'no-store', ...init })
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
  const { mode, manage, sshSandboxes } = await json<{
    mode: string
    manage?: boolean
    sshSandboxes?: string[]
  }>('./console-config.json', signal).catch((error: unknown) => {
    if (error instanceof GatewayError && error.status === 404)
      throw new Error('未配置 Gateway 控制台')
    if (error instanceof SyntaxError) throw new Error('Gateway 控制台配置无效')
    throw error
  })
  if (mode !== 'gateway') throw new Error('Gateway 控制台配置无效')
  const base = './api/v1/sandboxes'
  const gatewayCapabilities = await json<GatewayCapabilities>(
    './api/v1/capabilities',
    signal,
  ).catch(() => null)
  const capabilities = gatewayCapabilities
    ? {
        ...gatewayCapabilities.capabilities,
        tunnel_enabled: gatewayCapabilities.tunnel_enabled,
        observer_enabled: gatewayCapabilities.observer_enabled === true,
      }
    : defaultCapabilities
  return {
    manage: manage === true,
    sshSandboxes,
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
    accessKeys:
      manage && capabilities.access_keys
        ? (s) => json<AccessReport>('./api/v1/access-keys', s)
        : undefined,
    addAccessKey:
      manage && capabilities.access_keys
        ? (profile, key) =>
            json<AccessReport>('./api/v1/access-keys', undefined, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Ursi-Action': 'manage',
              },
              body: JSON.stringify({ profile, key }),
            })
        : undefined,
    removeAccessKey:
      manage && capabilities.access_keys
        ? (profile, fingerprint) =>
            json<AccessReport>('./api/v1/access-keys', undefined, {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                'X-Ursi-Action': 'manage',
              },
              body: JSON.stringify({ profile, fingerprint }),
            })
        : undefined,
    probeIdentity: () => json<ProbeIdentity>('./access/probe'),
    probeSandbox:
      manage && capabilities.access_keys
        ? (sandboxId) =>
            json<ProbeResult>('./access/probe', undefined, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Ursi-Action': 'manage',
              },
              body: JSON.stringify({ sandbox_id: sandboxId }),
            })
        : undefined,
    images: (s) => json<ImageInventory>('./api/v1/images', s),
    registry: manage ? (s) => json<Registry>('./api/v1/registry', s) : undefined,
    replaceRegistry: manage
      ? (registry) => json<Registry>('./api/v1/registry', undefined, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Ursi-Action': 'manage',
          },
          body: JSON.stringify(registry),
        })
      : undefined,
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
