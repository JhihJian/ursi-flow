import { requestV2 } from '@/shared/http/client'
import type { ConfigSchema } from '@/modules/definitions/config'

export interface Executor {
  id: string
  revision: number
  resources?: { id: string; revision: number }[]
  configSchema?: ConfigSchema
}
/** 平台分配的目录能力引用。`id` 是平台标识，不是宿主路径。 */
export interface WorkspaceRef { id: string; access: 'read-write'; purpose: string }
/** 启动时冻结的工作指令。旧尝试没有这一字段。 */
export interface WorkInstruction { text: string; encoding: 'utf-8' }
/** 一次尝试独占的制品目录；终态后冻结为只读。 */
export interface ArtifactDirectory { id: string; state: 'writable' | 'frozen' }
export interface PlatformLogEntry {
  sequence: number
  occurredAt: number
  source: 'platform'
  event: string
  message: string
  attemptStatus: Attempt['status']
}
/** 执行器自己产生的日志载荷。当前只承接 Agent 的原始文本。 */
export interface ExecutorLog {
  source: string
  kind: 'text'
  entries: { sequence: number; occurredAt: number; stream: string; text: string }[]
}
export interface Attempt {
  id: string
  action: string
  status: 'starting' | 'running' | 'unverified' | 'failed' | 'cancelled' | 'succeeded'
  executor: Executor
  executorIntegration?: { id: string; revision: number }
  workspace: WorkspaceRef
  workInstruction: WorkInstruction | null
  artifactDirectory: ArtifactDirectory | null
  platformLog: PlatformLogEntry[]
  executorLog: ExecutorLog | null
  /** 执行器自建静态日志页地址；当前不生成，为 null 时不渲染链接。 */
  executorLogPage: string | null
  backendRunId: string | null
  output: string | null
  interruptedStatus?: string
  /** 平台恢复提示。与执行器 output 分开保存，不互相覆盖。 */
  recoveryNotice?: string
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
