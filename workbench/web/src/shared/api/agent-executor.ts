import { requestV2 } from '@/shared/http/client'

export type ExecutorRef = { id: string; revision: number }
export type AgentConfig = { configPackageId: string }
export type PublishedAgent = AgentConfig | { systemPrompt: string; modelProfile: string; tools: string[] }
export type AgentDefinition = { id: string; agent: AgentConfig }
export type AgentOptions = { models: { id: string }[]; tools: { id: string }[] }
export type AttemptTarget = { executorRef: ExecutorRef; previewDefinition?: never } | { previewDefinition: AgentDefinition; executorRef?: never }
export type AttemptRequest = AttemptTarget & { workPatchId?: string; workInstruction: { encoding: 'utf-8'; text: string } }
export type AttemptResult = {
  attemptId: string
  status: 'starting' | 'running' | 'unverified' | 'succeeded' | 'failed' | 'cancelled'
  artifactDirectoryId?: string
}

export const executorChoices = (signal: AbortSignal) => requestV2<(ExecutorRef & { active: boolean })[]>('/executors', { signal })
export const executorRevisions = (id: string, signal: AbortSignal) => requestV2<(ExecutorRef & { agent?: PublishedAgent })[]>(`/executors/${encodeURIComponent(id)}/revisions`, { signal })

const path = (id: string) => `/executor-attempts/${encodeURIComponent(id)}`
export const agentOptions = (signal: AbortSignal) => requestV2<AgentOptions>('/agent-options', { signal })
export const startAttempt = (id: string, body: AttemptRequest, signal?: AbortSignal) =>
  requestV2<AttemptResult>(path(id), { method: 'PUT', body: JSON.stringify(body), signal })
export const inspectAttempt = (id: string, signal?: AbortSignal) => requestV2<AttemptResult>(path(id), { signal })
export const cancelAttempt = (id: string, signal?: AbortSignal) => requestV2<AttemptResult>(`${path(id)}/cancel`, { method: 'POST', signal })
