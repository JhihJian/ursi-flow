import { requestV2 } from '@/shared/http/client'

export const categories = {
  pending: '待开始工作', active: '正在进行中工作', continuous: '持续工作', completed: '已完成工作',
}
export type Category = keyof typeof categories
export type ResourceRef = { alias: string; serverId: string; uri: string }
export type Recipe = { resources: ResourceRef[]; script: string }
export type WorkDraft = { title: string; description: string; category: Category; recipe: Recipe | null }
export type WorkItem = WorkDraft & { id: string; revision: number }
export type ServerDraft = { name: string; url: string; credentialEnv?: string }
export type McpServer = ServerDraft & { id: string }
export type McpResource = { name: string; uri: string }

export const workItemPath = (id: string) => `/work-items/${encodeURIComponent(id)}`
export const listWorkItems = (signal: AbortSignal) => requestV2<WorkItem[]>('/work-items', { signal })
export const getWorkItem = (id: string, signal: AbortSignal) => requestV2<WorkItem>(workItemPath(id), { signal })
export function saveWorkItem(draft: WorkDraft, item: WorkItem | undefined, signal: AbortSignal) {
  return requestV2<WorkItem>(item ? workItemPath(item.id) : '/work-items', {
    method: item ? 'PUT' : 'POST', body: JSON.stringify(item ? { ...draft, revision: item.revision } : draft), signal,
  })
}
export const deleteWorkItem = (id: string, signal: AbortSignal) => requestV2<void>(workItemPath(id), { method: 'DELETE', signal })
export const generatePatch = (id: string, requestId: string, signal: AbortSignal) =>
  requestV2<{ id: string }>(`${workItemPath(id)}/generate`, { method: 'POST', body: JSON.stringify({ requestId }), signal })

export const listServers = (signal: AbortSignal) => requestV2<McpServer[]>('/mcp-servers', { signal })
export const addServer = (draft: ServerDraft, signal: AbortSignal) =>
  requestV2<McpServer>('/mcp-servers', { method: 'POST', body: JSON.stringify(draft), signal })
export const removeServer = (id: string, signal: AbortSignal) =>
  requestV2<void>(`/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
export const listResources = (id: string, signal: AbortSignal) =>
  requestV2<McpResource[]>(`/mcp-servers/${encodeURIComponent(id)}/resources`, { signal })
