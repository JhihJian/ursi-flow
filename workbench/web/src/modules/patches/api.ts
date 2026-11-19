import { requestV2, requestV2File } from '@/shared/http/client'

export type PatchKind = 'work' | 'config'
export interface Patch { id: string; name: string }
export interface Entry { path: string; kind: 'file' | 'dir'; size?: number }
export interface Directory {
  tree(signal?: AbortSignal): Promise<Entry[]>
  read(path: string, signal?: AbortSignal): Promise<Blob>
  write(path: string, data: Blob | string, replace?: boolean): Promise<void>
  mkdir(path: string): Promise<void>
  move(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

export const listPatches = (kind: PatchKind, signal?: AbortSignal) =>
  requestV2<Patch[]>(`/patches/${kind}`, { signal })
export const createPatch = (kind: PatchKind, name: string) =>
  requestV2<Patch>(`/patches/${kind}`, { method: 'POST', body: JSON.stringify({ name }) })

export function directory(kind: PatchKind, id: string): Directory {
  const base = `/patches/${kind}/${encodeURIComponent(id)}`
  const query = (path: string) => new URLSearchParams({ path }).toString()
  return {
    tree: signal => requestV2<Entry[]>(`${base}/tree`, { signal }),
    read: (path, signal) => requestV2File(`${base}/file?${query(path)}`, { signal }),
    write: (path, body, replace = false) => requestV2<void>(`${base}/file?${query(path)}${replace ? '&replace=true' : ''}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body,
    }),
    mkdir: path => requestV2<void>(`${base}/dir`, { method: 'POST', body: JSON.stringify({ path }) }),
    move: (from, to) => requestV2<void>(`${base}/move`, { method: 'POST', body: JSON.stringify({ from, to }) }),
    remove: path => requestV2<void>(`${base}/entry?${query(path)}`, { method: 'DELETE' }),
  }
}
