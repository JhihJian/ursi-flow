/**
 * 真实 HTTP 请求辅助。只用于准备场景数据和核对服务端事实，
 * 不替代浏览器操作，也不是 page.route 替身。
 */
import { readRuntime } from './runtime'

export interface WorkItemView {
  id: string
  package: string
  revision: number
  assignee: string | null
  status: 'pending' | 'working' | 'review' | 'delivered'
  input: Record<string, unknown>
  source: { type: string; provider?: string; itemId?: string; action?: string }
  packageSnapshot: {
    sop: string
    acceptance: string
    deliverables?: string[]
    actions: Record<string, { executor: { id: string; revision: number }; resources: Array<{ id: string; revision: number }> }>
  }
  attempts: Array<{ id: string; action: string; status: string; output: string | null }>
  deliveries: Array<{ version: number; files: Record<string, string>; attemptIds: string[]; review: null | { decision: string; reviewer: string; comment: string } }>
  acceptedVersion: number | null
}

export class Api {
  constructor(private readonly base: string, private readonly token: string) {}

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}/api/v2${route}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${route} 失败：HTTP ${response.status} ${text}`)
    return (text ? JSON.parse(text) : undefined) as T
  }

  get<T>(route: string) { return this.call<T>('GET', route) }
  post<T>(route: string, body?: unknown) { return this.call<T>('POST', route, body) }

  /** 发布一个定义版本，返回其 ID 与修订号。 */
  async publish<T extends { id: string; revision: number }>(kind: 'resources' | 'executors' | 'packages', body: unknown) {
    const doc = await this.post<T>(`/${kind}`, body)
    return { id: doc.id, revision: doc.revision }
  }

  item(id: string) { return this.get<WorkItemView>(`/items/${encodeURIComponent(id)}`) }
}

export function mainApi() {
  const runtime = readRuntime()
  return new Api(runtime.mainApi, runtime.token)
}

export function sourcesApi() {
  const runtime = readRuntime()
  return new Api(runtime.sourcesApi, runtime.token)
}
