import { requestV2 } from '@/shared/http/client'
import type { AgentConfig } from '@/shared/api/agent-executor'
import type { ConfigSchema } from './config'

export const titles = { executors: '执行器', resources: '资源' } as const
export type Collection = keyof typeof titles
export type Ref = { id: string; revision: number }
export type ResourceKind = 'skill' | 'prompt' | 'mcp'
export type Executor = Ref & { resources?: Ref[]; configSchema?: ConfigSchema; agent?: AgentConfig }
export type Resource = Ref & { kind: ResourceKind; content: string | { serverRef: string; credentialRef?: string } }
export type Definition = Resource | Executor
export type Latest = Definition & { active: boolean }
export const resourceKindNames = { skill: 'Skill', prompt: '提示词', mcp: 'MCP 引用' } as const

export const routePath = (k: Collection) => `/${k}`
export const objectPath = (k: Collection, id: string) => `${routePath(k)}/${encodeURIComponent(id)}`
export const revisionPath = (k: Collection, r: Ref) => `${objectPath(k, r.id)}/revisions/${r.revision}`
const apiPath = (k: Collection, id?: string) => id ? `/${k}/${encodeURIComponent(id)}` : `/${k}`
export const list = (k: Collection, signal: AbortSignal) => requestV2<Latest[]>(apiPath(k), { signal })
export const history = (k: Collection, id: string, signal: AbortSignal) => requestV2<Definition[]>(`${apiPath(k, id)}/revisions`, { signal })
export async function readVersion(k: Collection, id: string, revision: string | undefined, signal: AbortSignal) {
  const path = apiPath(k, id)
  const [latest, frozen] = await Promise.all([
    requestV2<Latest>(path, { signal }),
    revision ? requestV2<Definition>(`${path}/revisions/${encodeURIComponent(revision)}`, { signal }) : null,
  ])
  return { latest, version: frozen ?? latest }
}
export const deactivate = (k: Collection, id: string) => requestV2<Latest>(`${apiPath(k, id)}/deactivate`, { method: 'POST' })
export const publish = (k: Collection, body: unknown) => requestV2<Definition>(apiPath(k), { method: 'POST', body: JSON.stringify(body) })
export function pinned(r: Ref): Ref { return { id: r.id, revision: r.revision } }
