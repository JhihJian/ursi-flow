import { requestV2, requestV2Text } from '@/shared/http/client'

export interface WorkspaceRole { id: string; label: string }
export interface WorkspaceSop {
  id: string
  revision: number
  executor?: string
  config?: { title?: string }
}
export interface WorkspaceType {
  id: string
  name: string
  roles: WorkspaceRole[]
  sop: WorkspaceSop
}
export interface WorkspaceMaterial { role: string; name: string; size: number }
export type WorkspaceAttemptStatus = 'succeeded' | 'failed'
export interface WorkspaceAttempt {
  id: string
  status: WorkspaceAttemptStatus
  error?: string
}
export interface WorkspaceDetail {
  id: string
  typeId: string
  requirement: string
  frozen: boolean
  roles: WorkspaceRole[]
  sop: WorkspaceSop
  materials: WorkspaceMaterial[]
  attempts: WorkspaceAttempt[]
}

export const attemptStatus: Record<WorkspaceAttemptStatus, string> = {
  succeeded: '已执行',
  failed: '失败',
}

const workspaceBase = (id: string) => `/workspaces/${encodeURIComponent(id)}`
export const workspacePath = workspaceBase
export const newWorkspacePath = '/workspaces/new'
export const resultPath = (id: string) => `${workspaceBase(id)}/result`
const receiptPath = (id: string, attempt: string) =>
  `${workspaceBase(id)}/attempts/${encodeURIComponent(attempt)}/receipt`

export function listTypes(signal: AbortSignal) {
  return requestV2<WorkspaceType[]>('/workspace-types', { signal })
}
export function listWorkspaces(signal: AbortSignal) {
  return requestV2<WorkspaceDetail[]>('/workspaces', { signal })
}
export function readWorkspace(id: string, signal: AbortSignal) {
  return requestV2<WorkspaceDetail>(workspaceBase(id), { signal })
}
export function createWorkspace(body: { typeId: string; requirement: string }) {
  return requestV2<WorkspaceDetail>('/workspaces', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
export function updateRequirement(id: string, requirement: string) {
  return requestV2<WorkspaceDetail>(workspaceBase(id), {
    method: 'PATCH',
    body: JSON.stringify({ requirement }),
  })
}
/** 材料按原始字节上传，文件名只作为查询参数；服务端决定存储路径。 */
export function uploadMaterial(id: string, role: string, name: string, file: Blob) {
  return requestV2<WorkspaceDetail>(
    `${workspaceBase(id)}/materials/${encodeURIComponent(role)}?name=${encodeURIComponent(name)}`,
    { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
  )
}
export function runAttempt(id: string) {
  return requestV2<WorkspaceDetail>(`${workspaceBase(id)}/attempts`, {
    method: 'POST',
    body: '{}',
  })
}
export function readReceipt(id: string, attempt: string, signal: AbortSignal) {
  return requestV2Text(receiptPath(id, attempt), { signal })
}
/**
 * 回执是纯文本，下载复用预览的鉴权读取，再由浏览器保存为 receipt.md。
 * 服务端的 `?download=true` 只影响响应头，正文仍是同一份 UTF-8 回执。
 */
export async function downloadReceipt(id: string, attempt: string) {
  const text = await requestV2Text(`${receiptPath(id, attempt)}?download=true`)
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = 'receipt.md'
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

export function materialOf(workspace: WorkspaceDetail, role: string) {
  return workspace.materials.find(material => material.role === role)
}

export function lastAttempt(workspace: WorkspaceDetail) {
  return workspace.attempts.at(-1)
}

export function formatSize(size: number) {
  if (!Number.isFinite(size) || size < 0) return '大小未知'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
