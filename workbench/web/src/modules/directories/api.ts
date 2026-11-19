import { requestV2, requestV2File } from '@/shared/http/client'

export interface Entry { path: string; kind: 'file' | 'dir'; size?: number }
export interface DirectoryRef { id: string }
export interface Directory {
  tree(signal?: AbortSignal): Promise<Entry[]>
  read(path: string, signal?: AbortSignal): Promise<Blob>
  write(path: string, data: Blob | string, replace?: boolean): Promise<void>
  mkdir(path: string): Promise<void>
  move(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

const base = (id: string) => `/directories/${encodeURIComponent(id)}`

/** 目录标识由服务端分配，请求体只是空对象。 */
export const createDirectory = () =>
  requestV2<DirectoryRef>('/directories', { method: 'POST', body: JSON.stringify({}) })

/** 读取目录标识；只返回标识，不公布宿主路径。 */
export const getDirectory = (id: string, signal?: AbortSignal) =>
  requestV2<DirectoryRef>(base(id), { signal })

/** 按标识操作目录内容，路径一律是目录根相对路径。 */
export function directoryClient(id: string): Directory {
  const root = base(id)
  const query = (path: string) => new URLSearchParams({ path }).toString()
  return {
    tree: signal => requestV2<Entry[]>(`${root}/tree`, { signal }),
    read: (path, signal) => requestV2File(`${root}/file?${query(path)}`, { signal }),
    write: (path, body, replace = false) => requestV2<void>(`${root}/file?${query(path)}${replace ? '&replace=true' : ''}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body,
    }),
    mkdir: path => requestV2<void>(`${root}/dir`, { method: 'POST', body: JSON.stringify({ path }) }),
    move: (from, to) => requestV2<void>(`${root}/move`, { method: 'POST', body: JSON.stringify({ from, to }) }),
    remove: path => requestV2<void>(`${root}/entry?${query(path)}`, { method: 'DELETE' }),
  }
}
