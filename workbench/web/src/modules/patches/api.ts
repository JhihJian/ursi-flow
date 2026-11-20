import { ApiError, requestV2 } from '@/shared/http/client'

export type PatchKind = 'work' | 'config'
/** 包记录：名称与目录标识都由服务端生成，界面按目录标识打开内容。 */
export interface Patch {
  id: string
  name: string
  directoryId: string
  workItemId?: string | null // 仅文件型工作包有归属
  provenance?: {
    workItemId: string; workItemTitle: string; revision: number; scriptSha256: string
    resources: { alias: string; serverId: string; uri: string; sha256: string; readAt: number }[]
  } | null
  source?: string
  createdAt?: number // Unix 秒
  executionStatus?: 'not_started' | 'running' | 'succeeded' | 'failed'
}

/** 配置选择器的窄边界：目录标识只供编辑台使用，不进入执行器配置表单。 */
export type ConfigPackageChoice = Pick<Patch, 'id' | 'name'>

export const listPatches = (kind: PatchKind, signal?: AbortSignal) =>
  requestV2<Patch[]>(`/patches/${kind}`, { signal })

export async function getWorkPatch(id: string, signal: AbortSignal): Promise<Patch | null> {
  try {
    return await requestV2<Patch>(`/patches/work/${encodeURIComponent(id)}`, { signal })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export const setPatchOwner = (id: string, workItemId: string | null, signal: AbortSignal) =>
  requestV2<void>(`/patches/work/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ workItemId }), signal })

export async function listConfigPackageChoices(signal?: AbortSignal): Promise<ConfigPackageChoice[]> {
  const patches = await listPatches('config', signal)
  return patches.map(({ id, name }) => ({ id, name }))
}
export const createPatch = (kind: PatchKind, name: string) =>
  requestV2<Patch>(`/patches/${kind}`, { method: 'POST', body: JSON.stringify({ name }) })
