/** 前端与演示 API 共用的传输契约，业务状态转换由 API 实现负责。 */
export interface Skill { name: string; content: string }
export interface McpServer { name: string; transport: 'stdio' | 'http'; command?: string; url?: string; credentialRef?: string }
export interface Role {
  id: string; name: string; description: string; icon: string; color: string
  systemPrompt: string; model: string; connectionId: string; executor: string
  skills: Skill[]; mcpServers: McpServer[]; updatedAt: string
}
export interface Connection {
  id: string; name: string; provider: string; baseUrl: string; model: string; credentialRef: string; updatedAt: string
}
export interface WorkflowNode { id: string; name: string; type: 'agent' | 'approval' | 'script'; roleId?: string; script?: string }
export interface Workflow {
  id: string; name: string; description: string; nodes: WorkflowNode[]
  edges: { source: string; target: string }[]; updatedAt: string
}
export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
export interface NodeRun { id: string; name: string; type: WorkflowNode['type']; status: 'pending' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled'; roleId?: string; output?: string }
export interface RunEvent { id: string; at: string; nodeId?: string; type: 'state' | 'log' | 'tool'; message: string }
export interface Run {
  id: string; name: string; workflowId: string; workflowName: string; status: RunStatus
  createdAt: string; updatedAt: string; attempt: number; nodes: NodeRun[]
  snapshot: { workflow: Workflow; roles: Role[]; connections: Connection[] }
  events: RunEvent[]; sandboxId: string; input: string
}
export interface Artifact {
  id: string; name: string; path: string; contentType: string; content: string
  runId: string; nodeId: string; attempt: number; size: number; createdAt: string
}
export interface Sandbox {
  id: string; name: string; runId: string; status: 'running' | 'released' | 'failed'
  image: string; createdAt: string; cpu: string; memory: string; workspace: string; logs: string[]
}
