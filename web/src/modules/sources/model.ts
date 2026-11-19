import { requestV2 } from '@/shared/http/client'

export interface SourceSummary { id: string; kind: string; actions: string[] }
export interface SourceItem { id: string; title: string }
export interface SourceItemDetail extends SourceItem { input: Record<string, unknown>; actions: string[] }
export interface DispatchedItem { id: string; status: string }

export function sourcePath(provider: string) { return `/sources/${encodeURIComponent(provider)}` }
export function sourceItemsPath(provider: string) { return `${sourcePath(provider)}/items` }
export function sourceItemPath(provider: string, id: string) { return `${sourceItemsPath(provider)}/${encodeURIComponent(id)}` }

export function listSources(signal: AbortSignal) { return requestV2<SourceSummary[]>('/sources', { signal }) }
export function listSourceItems(provider: string, signal: AbortSignal) { return requestV2<SourceItem[]>(sourceItemsPath(provider), { signal }) }
export function readSourceItem(provider: string, id: string, signal: AbortSignal) { return requestV2<SourceItemDetail>(sourceItemPath(provider, id), { signal }) }

/**
 * 固定动作派工。请求体只允许服务端公布的 `action` 与请求标识，
 * 包、修订、执行器和输入均由管理员配置与服务端重新读取导出决定。
 * 同一条目动作重试须传入原请求标识，服务端据此只建一张单。
 */
export function dispatchSource(provider: string, id: string, requestId: string, action: string) {
  return requestV2<DispatchedItem>(`${sourceItemPath(provider, id)}/dispatch`, {
    method: 'POST',
    body: JSON.stringify({ requestId, action }),
  })
}

/** 无 HTTPS 的内网部署没有 randomUUID，改用 getRandomValues 生成请求标识。 */
export function sourceRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `source-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * 共享资源的错误被 `useResource` 转成消息字符串，状态码保留在 `HTTP <状态>` 前缀。
 * 这里只取状态码用于区分呈现，不向页面透出服务端原文。
 */
export function sourceErrorStatus(error: string): number | null {
  const match = /^HTTP (\d{3})/.exec(error)
  return match ? Number(match[1]) : null
}

export type SourceFault = 'unconfigured' | 'unavailable' | 'failed'

/** 目录与条目列表：404 为未配置来源，503 为导出不可用，其余按一般故障处理。 */
export function sourceFault(error: string): SourceFault {
  const status = sourceErrorStatus(error)
  if (status === 404) return 'unconfigured'
  if (status === 503) return 'unavailable'
  return 'failed'
}
