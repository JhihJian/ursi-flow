import { requestV2 } from '@/shared/http/client'

export type ItemStatus = 'pending' | 'working' | 'review' | 'delivered'
export const itemStatus: Record<ItemStatus, string> = {
  pending: '待办理', working: '办理中', review: '待验收', delivered: '已交付',
}
export const statusOptions: Array<{ value: ItemStatus | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'pending', label: itemStatus.pending },
  { value: 'working', label: itemStatus.working },
  { value: 'review', label: itemStatus.review },
  { value: 'delivered', label: itemStatus.delivered },
]

export interface ItemSummary {
  id: string
  package: string
  revision: number
  status: ItemStatus
  assignee: string | null
  source: { type: string; provider?: string; itemId?: string; action?: string }
}
export type InputType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
export type InputDeclarations = Record<string, InputType>
export interface WorkPackage {
  id: string
  revision: number
  sop: string
  acceptance: string
  inputs?: InputDeclarations
  deliverables?: string[]
  actions: Record<string, unknown>
}
/** `GET /packages` 的最新版正文，额外带对象的启用状态。 */
export interface PackageSummary extends WorkPackage { active: boolean }
export interface CreateItemResponse { id: string; status: ItemStatus }

export function itemPath(id: string) { return `/items/${encodeURIComponent(id)}` }
export function listItems(status: ItemStatus | '', signal: AbortSignal) {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return requestV2<ItemSummary[]>(`/items${query}`, { signal })
}
/** 目录里所有对象的最新版，含已停用对象；派工只接受 `active` 的包。 */
export function readPackages(signal: AbortSignal) {
  return requestV2<PackageSummary[]>('/packages', { signal })
}
/** 指定包的冻结修订，按版本从早到晚；正文与对应修订的读取结果一致。 */
export function readRevisions(id: string, signal: AbortSignal) {
  return requestV2<WorkPackage[]>(`/packages/${encodeURIComponent(id)}/revisions`, { signal })
}
export function createItem(body: {
  requestId: string
  package: string
  revision: number
  input: Record<string, unknown>
}, signal: AbortSignal) {
  return requestV2<CreateItemResponse>('/items', {
    method: 'POST', body: JSON.stringify(body), signal,
  })
}
