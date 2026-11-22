import { requestJson } from '@/shared/http/client'
import type { ExecutorRef } from './agent-executor'
import type { FlowFiles, FlowPackage, Revision, Run, RunHistory, FlowConfig } from './types'

const flowPath = (id: string) => `/flows/${encodeURIComponent(id)}`
const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`
const send = <T>(method: string, path: string, body?: unknown) => requestJson<T>(path, { method, body: JSON.stringify(body) })

export const runtime = {
  flows: (signal?: AbortSignal) => requestJson<string[]>('/flows', { signal }),
  flow: (id: string, signal?: AbortSignal) => requestJson<FlowPackage>(flowPath(id), { signal }),
  create: (id: string, files: FlowFiles) => send<Revision>('POST', '/flows', { id, files }),
  validate: (id: string, files: FlowFiles) => send<{ id: string; valid: boolean }>('POST', '/flows/validate', { id, files }),
  update: (id: string, files: FlowFiles, expectedRevision: string) => send<Revision>('PUT', flowPath(id), { files, expectedRevision }),
  remove: (id: string) => send('DELETE', flowPath(id)),
  start: (id: string, variables: Record<string, unknown>, runId?: string, executorRef?: ExecutorRef) => send<Run>('POST', `${flowPath(id)}/runs`, { runId, workspace: 'default', variables, executorRef }),
  runs: (signal?: AbortSignal) => requestJson<Run[]>('/runs', { signal }),
  run: (id: string, signal?: AbortSignal) => requestJson<Run>(runPath(id), { signal }),
  history: (id: string, signal?: AbortSignal) => requestJson<RunHistory>(`${runPath(id)}/history`, { signal }),
  stop: (id: string) => send<Run>('POST', `${runPath(id)}/stop`),
  config: (signal?: AbortSignal) => requestJson<FlowConfig>('/flow-config', { signal }),
  configure: (patch: Partial<FlowConfig>) => send<FlowConfig>('PATCH', '/flow-config', patch),
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。'
}
