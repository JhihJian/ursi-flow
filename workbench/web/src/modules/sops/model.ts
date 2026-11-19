import { requestV2 } from '@/shared/http/client'

export interface SopVersion {
  id: string
  revision: number
  executor: string
  config: { title: string }
}
export type SopRef = Pick<SopVersion, 'id' | 'revision'>
export interface SopGroup {
  id: string
  title: string
  latest: SopVersion
  versions: SopVersion[]
}

export const sopsPath = '/sops'
export const newSopPath = '/sops/new'
export const sopPath = (id: string) => `${sopsPath}/${encodeURIComponent(id)}`
export const historyPath = (id: string) => `${sopPath(id)}/revisions`
export const revisionPath = (v: SopRef) => `${historyPath(v.id)}/${v.revision}`
export const editPath = (v: SopRef) => `${revisionPath(v)}/edit`

/** 服务端当前只接受内置 Echo，执行器以选择器呈现，配置字段随执行器而定。 */
export const sopExecutors = {
  echo: {
    name: 'Echo（内置回执执行器）',
    hint: '读取工作区材料并写出纯文本回执，不需要外部服务。',
    titleHint: '回执标题写在回执开头，用来识别这份回执，不是 SOP 正文；正文由 Echo 的固定流程生成。',
  },
} as const
export type SopExecutorId = keyof typeof sopExecutors
export const executorIds = Object.keys(sopExecutors) as SopExecutorId[]
export function executorInfo(id: string) {
  return sopExecutors[id as SopExecutorId] ?? { name: id, hint: '未登记的执行器，页面只显示它的名称。', titleHint: '未登记的执行器没有可调整的配置字段。' }
}
export const executorName = (id: string) => executorInfo(id).name

export const sopTitle = (v: SopVersion) => v.config?.title?.trim() || v.id

export function listSops(signal: AbortSignal) {
  return requestV2<SopVersion[]>(sopsPath, { signal })
}

export function publishSop(body: { id: string; executor: SopExecutorId; config: { title: string } }) {
  return requestV2<SopVersion>(sopsPath, { method: 'POST', body: JSON.stringify(body) })
}

/** 集合接口返回全部已发布修订，目录、历史和版本页都从同一份结果按 ID 分组。 */
export function groupVersions(versions: SopVersion[]): SopGroup[] {
  const groups = new Map<string, SopVersion[]>()
  for (const version of versions) {
    groups.set(version.id, [...(groups.get(version.id) ?? []), version])
  }
  return Array.from(groups, ([id, list]) => {
    const sorted = [...list].sort((a, b) => b.revision - a.revision)
    const latest = sorted[0]!
    return { id, title: sopTitle(latest), latest, versions: sorted }
  }).sort((a, b) => a.id.localeCompare(b.id))
}

export function findVersion(versions: SopVersion[], id: string, revision: string | number): SopVersion | undefined {
  const wanted = Number(revision)
  if (!Number.isInteger(wanted)) return undefined
  return versions.find(v => v.id === id && v.revision === wanted)
}

export function latestOf(versions: SopVersion[], id: string): SopVersion | undefined {
  return versions.filter(v => v.id === id).reduce<SopVersion | undefined>(
    (latest, v) => !latest || v.revision > latest.revision ? v : latest,
    undefined,
  )
}

const idPattern = /^[A-Za-z0-9_-]{1,80}$/

/** 与服务端一致：ID 只含字母、数字、短横线和下划线，标题非空、单行且不超过 256 字节。 */
export function validateDraft(id: string, title: string): string {
  if (!idPattern.test(id)) return 'SOP 标识只能使用 1 至 80 个字母、数字、短横线或下划线。'
  const trimmed = title.trim()
  if (!trimmed) return '请填写回执标题。'
  if (new TextEncoder().encode(trimmed).length > 256) return '回执标题不能超过 256 个字节。'
  if (Array.from(trimmed).some(ch => { const code = ch.charCodeAt(0); return code < 0x20 || (code >= 0x7f && code <= 0x9f) })) {
    return '回执标题必须是单行文本。'
  }
  return ''
}
