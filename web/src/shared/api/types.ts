export type FlowFiles = Record<string, string>
export interface Revision { id: string; revision: string }
export interface FlowPackage extends Revision { files: FlowFiles }
export interface FlowConfig { executor: 'local-pi'; model: string; maxConcurrent: number }
export interface Run extends Revision { flow: string; status: string; cwd: string; variables: Record<string, unknown>; config: FlowConfig; error?: string }
export interface RunHistory { job: Run; runs: unknown[]; nodeRuns: unknown[]; routeDecisions: unknown[]; [key: string]: unknown }

export interface ChatTextPart { type: 'text'; text: string }
export interface ChatReasoningPart { type: 'reasoning'; text: string }
export interface ChatToolPart { type: 'tool'; name: string; status: 'running' | 'succeeded' | 'failed'; output?: string }
export type ChatPart = ChatTextPart | ChatReasoningPart | ChatToolPart
export interface ChatMessage { id: string; role: 'user' | 'assistant'; at: string; parts: ChatPart[] }
export interface ChatSession { id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[] }
