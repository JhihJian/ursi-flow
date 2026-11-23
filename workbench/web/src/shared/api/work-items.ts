import { requestV2 } from '@/shared/http/client'

export const categories = {
  one_time: '一次性工作', continuous: '持续工作',
}
export type Category = keyof typeof categories
export const statuses = { pending: '待开始', active: '进行中', completed: '已完成' }
export type WorkStatus = keyof typeof statuses
export type WorkDraft = { title: string; description: string; category: Category; status: WorkStatus }
export type WorkItem = WorkDraft & { id: string; revision: number }

export const workItemPath = (id: string) => `/work-items/${encodeURIComponent(id)}`
export const listWorkItems = (signal: AbortSignal) => requestV2<WorkItem[]>('/work-items', { signal })
export const getWorkItem = (id: string, signal: AbortSignal) => requestV2<WorkItem>(workItemPath(id), { signal })
export function saveWorkItem(fields: WorkDraft, item: WorkItem | undefined, signal: AbortSignal) {
  const { title, description, category, status } = fields
  return requestV2<WorkItem>(item ? workItemPath(item.id) : '/work-items', {
    method: item ? 'PUT' : 'POST',
    body: JSON.stringify({ title, description, category, ...(item && { status, revision: item.revision }) }), signal,
  })
}
export const deleteWorkItem = (id: string, signal: AbortSignal) => requestV2<void>(workItemPath(id), { method: 'DELETE', signal })
