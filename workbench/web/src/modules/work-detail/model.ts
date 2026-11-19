import { requestV2 } from '@/shared/http/client'

export interface Executor {
  id: string
  revision: number
  kind: 'agent' | 'flow'
  environment?: 'local' | 'sandbox'
  flowId?: string
  flowRevision?: string
}
export interface Attempt {
  id: string
  action: string
  status: 'starting' | 'running' | 'unverified' | 'failed' | 'cancelled' | 'succeeded'
  executor: Executor
  workspace: string
  backendRunId: string | null
  output: string | null
  interruptedStatus?: string
  verification?: { status: string; evidence: string; reason: string; daemonEvidence?: unknown }
}
export interface Delivery {
  version: number
  files: Record<string, string>
  attemptIds: string[]
  review: { decision: 'accept' | 'reject'; reviewer: string; comment: string } | null
}
export interface WorkItem {
  id: string
  package: string
  revision: number
  assignee: string | null
  status: 'pending' | 'working' | 'review' | 'delivered'
  input: Record<string, unknown>
  source: { type: string; action?: string; provider?: string; itemId?: string }
  packageSnapshot: {
    sop: string; acceptance: string; deliverables?: string[]
    actions: Record<string, { executor: Executor; resources: { id: string; revision: number }[] }>
  }
  attempts: Attempt[]
  deliveries: Delivery[]
  acceptedVersion: number | null
}
export const itemStatus = { pending: '待办理', working: '办理中', review: '待验收', delivered: '已交付' }
export const attemptStatus = { starting: '启动中', running: '执行中', unverified: '待核实', succeeded: '执行成功', failed: '执行失败', cancelled: '已取消' }
export const active = (a: Attempt) => a.status === 'starting' || a.status === 'running'
export const locked = (a: Attempt) => active(a) || a.status === 'unverified'
export const itemPath = (id: string) => `/items/${encodeURIComponent(id)}`
export const post = <T>(path: string, body?: unknown) => requestV2<T>(path, { method: 'POST', body: JSON.stringify(body) })
export type Write = (operation: () => Promise<void>) => Promise<void>
export const lastDelivery = (item: WorkItem) => item.deliveries.at(-1)
