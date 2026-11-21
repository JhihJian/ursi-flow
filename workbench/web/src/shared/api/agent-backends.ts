import { requestV2 } from '@/shared/http/client'

export type AgentBackend = {
  id: string
  label: string
  capabilities: ('skills' | 'tools')[]
  configured: boolean
  status: 'unchecked' | 'ready' | 'failed'
  checkedAt: number | null
}
export type PackageBackend = AgentBackend & { compatible: boolean }

const path = '/agent-backends'
export const listAgentBackends = (signal: AbortSignal) => requestV2<AgentBackend[]>(path, { signal })
export const listPackageBackends = (configPackageId: string, signal: AbortSignal) =>
  requestV2<PackageBackend[]>(`${path}?${new URLSearchParams({ configPackageId })}`, { signal })
export const checkAgentBackend = (id: string, signal: AbortSignal) =>
  requestV2<AgentBackend>(`${path}/${encodeURIComponent(id)}/check`, { method: 'POST', signal })
