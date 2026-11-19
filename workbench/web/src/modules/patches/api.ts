import { requestV2 } from '@/shared/http/client'

export type PatchKind = 'work' | 'config'
/** 包记录：名称与目录标识都由服务端生成，界面按目录标识打开内容。 */
export interface Patch {
  id: string
  name: string
  directoryId: string
  source?: string
  createdAt?: number // Unix 秒
  executionStatus?: 'not_started' | 'running' | 'succeeded' | 'failed'
}

/** 配置选择器的窄边界：目录标识只供编辑台使用，不进入执行器配置表单。 */
export type ConfigPackageChoice = Pick<Patch, 'id' | 'name'>

export const listPatches = (kind: PatchKind, signal?: AbortSignal) =>
  requestV2<Patch[]>(`/patches/${kind}`, { signal })

export async function listConfigPackageChoices(signal?: AbortSignal): Promise<ConfigPackageChoice[]> {
  const patches = await listPatches('config', signal)
  return patches.map(({ id, name }) => ({ id, name }))
}
export const createPatch = (kind: PatchKind, name: string) =>
  requestV2<Patch>(`/patches/${kind}`, { method: 'POST', body: JSON.stringify({ name }) })
