import { requestV2 } from '@/shared/http/client'
import type { GeneratorBinding } from './work-patch-generators'

export const categories = {
  one_time: '一次性工作', continuous: '持续工作',
}
export type Category = keyof typeof categories
export const statuses = { pending: '待开始', active: '进行中', completed: '已完成' }
export type WorkStatus = keyof typeof statuses
export type ResourceRef = { alias: string; serverId: string; uri: string }
export type Recipe = { resources: ResourceRef[]; script: string }
export type WorkDraft = { title: string; description: string; category: Category; status: WorkStatus; recipe: Recipe | null; generator?: GeneratorBinding | null }
export type WorkItem = WorkDraft & { id: string; revision: number }

export const workItemPath = (id: string) => `/work-items/${encodeURIComponent(id)}`
export const listWorkItems = (signal: AbortSignal) => requestV2<WorkItem[]>('/work-items', { signal })
export const getWorkItem = (id: string, signal: AbortSignal) => requestV2<WorkItem>(workItemPath(id), { signal })
export function saveWorkItem({ status, ...fields }: WorkDraft, item: WorkItem | undefined, signal: AbortSignal) {
  return requestV2<WorkItem>(item ? workItemPath(item.id) : '/work-items', {
    method: item ? 'PUT' : 'POST', body: JSON.stringify(item ? { ...fields, status, revision: item.revision } : fields), signal,
  })
}
export const deleteWorkItem = (id: string, signal: AbortSignal) => requestV2<void>(workItemPath(id), { method: 'DELETE', signal })
export const generatePatch = (id: string, requestId: string, signal: AbortSignal) =>
  requestV2<{ id: string }>(`${workItemPath(id)}/generate`, { method: 'POST', body: JSON.stringify({ requestId }), signal })
