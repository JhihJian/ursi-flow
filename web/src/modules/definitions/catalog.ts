import { requestV2 } from '@/shared/http/client'

export const titles = { packages: '工作包', executors: '执行器', resources: '资源' } as const
export type Collection = keyof typeof titles
export type Ref = { id: string; revision: number }
export type Ports = Record<string, string>
export type ResourceKind = 'skill' | 'prompt' | 'mcp'
export type ExecutorKind = 'agent' | 'flow'
export type Target = Ref & { kind: ExecutorKind; environment?: 'local' | 'sandbox'; flowId?: string; flowRevision?: string }
export type Resource = Ref & { kind: ResourceKind; content: string | { serverRef: string; credentialRef?: string } }
export type Executor = Target & { resources?: Ref[]; inputs?: Ports; outputs?: Ports }
export type Package = Ref & {
  goal?: unknown; sop: string; acceptance: string; deliverables?: string[]; resources?: Ref[]; inputs?: Ports; outputs?: Ports
  actions: Record<string, { executor: Target; resources: Resource[] }>
}
export type Definition = Resource | Executor | Package
export type Latest = Definition & { active: boolean }
export const kindNames = { skill: 'Skill', prompt: '提示词', mcp: 'MCP 引用', agent: 'Agent', flow: 'Agent Flow' }
export const objectPath = (k: Collection, id: string) => `/${k}/${encodeURIComponent(id)}`
export const revisionPath = (k: Collection, r: Ref) => `${objectPath(k, r.id)}/revisions/${r.revision}`
export const list = (k: Collection, signal: AbortSignal) => requestV2<Latest[]>(`/${k}`, { signal })
export const history = (k: Collection, id: string, signal: AbortSignal) => requestV2<Definition[]>(`${objectPath(k, id)}/revisions`, { signal })
export async function readVersion(k: Collection, id: string, revision: string | undefined, signal: AbortSignal) {
  const path = objectPath(k, id)
  const [latest, frozen] = await Promise.all([
    requestV2<Latest>(path, { signal }),
    revision ? requestV2<Definition>(`${path}/revisions/${encodeURIComponent(revision)}`, { signal }) : null,
  ])
  return { latest, version: frozen ?? latest }
}
export const deactivate = (k: Collection, id: string) => requestV2<Latest>(`${objectPath(k, id)}/deactivate`, { method: 'POST' })
export const publish = (k: Collection, body: unknown) => requestV2<Definition>(`/${k}`, { method: 'POST', body: JSON.stringify(body) })
export function pinned(r: Ref): Ref { return { id: r.id, revision: r.revision } }
export function sameRef(a: Ref, b: Ref) { return a.id === b.id && a.revision === b.revision }

// 快照只存三层合并后的资源。读固定执行器版本，不用目录最新版推断继承关系。
export async function boundExecutors(pkg: Package, signal: AbortSignal) {
  const paths = new Set(Object.values(pkg.actions).map(a => revisionPath('executors', a.executor)))
  return Promise.all(Array.from(paths, path => requestV2<Executor>(path, { signal })))
}
