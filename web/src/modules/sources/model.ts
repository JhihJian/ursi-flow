import { requestV2 } from '@/shared/http/client'

export interface SourceSummary { id: string; kind: string; actions: string[] }
export interface SourceItem { id: string; title: string }
export interface SourceItemDetail extends SourceItem { input: Record<string, unknown>; actions: string[] }
export interface DispatchResult { id: string; status: string }

export function sourcePath(provider: string) { return `/sources/${encodeURIComponent(provider)}` }
export function sourceItemsPath(provider: string) { return `${sourcePath(provider)}/items` }
export function sourceItemPath(provider: string, id: string) { return `${sourceItemsPath(provider)}/${encodeURIComponent(id)}` }
export function listSources(signal: AbortSignal) { return requestV2<SourceSummary[]>('/sources', { signal }) }
export function listSourceItems(provider: string, signal: AbortSignal) { return requestV2<SourceItem[]>(sourceItemsPath(provider), { signal }) }
export function readSourceItem(provider: string, id: string, signal: AbortSignal) { return requestV2<SourceItemDetail>(sourceItemPath(provider, id), { signal }) }
export function dispatchSource(provider: string, id: string, requestId: string, action: string) {
  return requestV2<DispatchResult>(`${sourceItemPath(provider, id)}/dispatch`, {
    method: 'POST', body: JSON.stringify({ requestId, action }),
  })
}
export function sourceRequestId(provider: string, id: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `source-${provider}-${id}-${random}`
}
