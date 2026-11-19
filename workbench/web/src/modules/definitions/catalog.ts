import { requestV2 } from '@/shared/http/client'
import type { ConfigSchema, ConfigValues, SecretConfigured } from './config'

export const titles = { packages: '派工模板', executors: '执行器', resources: '资源' } as const
/** 派工模板里的旧 SOP 文本叫办理说明，与独立可执行的 SOP 区分。 */
export const sopLabel = '办理说明'
export type Collection = keyof typeof titles
export type Ref = { id: string; revision: number }
export type Ports = Record<string, string>
export type ResourceKind = 'skill' | 'prompt' | 'mcp'
export type ExecutorKind = 'agent' | 'flow'
export type Target = Ref & { kind: ExecutorKind; environment?: 'local' | 'sandbox'; flowId?: string; flowRevision?: string }
export type Resource = Ref & { kind: ResourceKind; content: string | { serverRef: string; credentialRef?: string } }
export type Executor = Target & {
  resources?: Ref[]
  /** 服务端可选返回的动态配置描述。schema 不作为发布字段。 */
  configSchema?: ConfigSchema
  /** 只返回非敏感配置值；secret 仅返回是否已配置。 */
  config?: ConfigValues
  secretConfigured?: SecretConfigured
}
export type Package = Ref & {
  goal?: unknown; sop: string; acceptance: string; deliverables?: string[]; resources?: Ref[]; inputs?: Ports; outputs?: Ports
  actions: Record<string, { executor: Target; resources: Resource[] }>
}
export type Definition = Resource | Executor | Package
export type Latest = Definition & { active: boolean }
export const kindNames = { skill: 'Skill', prompt: '提示词', mcp: 'MCP 引用', agent: 'Agent', flow: 'Agent Flow' }
export const environmentNames = { local: '本地 Pi Agent', sandbox: '预配沙箱 Agent' } as const
export const environmentHints = {
  local: '在服务端所在机器上用服务端配置的 Agent 程序运行。',
  sandbox: '使用管理员预配的 ACP 沙箱。沙箱不可用时执行被拒绝，已发布的绑定不改变。',
} as const
export function environmentName(value?: string) { return environmentNames[value === 'sandbox' ? 'sandbox' : 'local'] }

/** 旧定义现在叫派工模板，页面归到 /templates；读取和发布仍用 `/api/v2/packages`。 */
export const routeBase = { packages: 'templates', resources: 'resources', executors: 'executors' } as const
export const routePath = (k: Collection) => `/${routeBase[k]}`
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
export function sameRef(a: Ref, b: Ref) { return a.id === b.id && a.revision === b.revision }

// 快照只存三层合并后的资源。读固定执行器版本，不用目录最新版推断继承关系。
export async function boundExecutors(pkg: Package, signal: AbortSignal) {
  const paths = new Set(Object.values(pkg.actions).map(a => `${apiPath('executors', a.executor.id)}/revisions/${a.executor.revision}`))
  return Promise.all(Array.from(paths, path => requestV2<Executor>(path, { signal })))
}
