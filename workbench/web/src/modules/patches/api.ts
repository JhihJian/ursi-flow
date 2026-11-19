import { requestV2 } from '@/shared/http/client'

export type PatchKind = 'work' | 'config'
/** 包记录：名称与目录标识都由服务端生成，界面按目录标识打开内容。 */
export interface Patch { id: string; name: string; directoryId: string }

export const listPatches = (kind: PatchKind, signal?: AbortSignal) =>
  requestV2<Patch[]>(`/patches/${kind}`, { signal })
export const createPatch = (kind: PatchKind, name: string) =>
  requestV2<Patch>(`/patches/${kind}`, { method: 'POST', body: JSON.stringify({ name }) })
