/* eslint-disable react-refresh/only-export-components -- 测试工具同时导出宿主组件与辅助函数。 */
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { useFeedbackStore } from '@/shared/stores/feedback'

import { Explorer, type ExplorerProps } from '../Explorer'
import type { Directory, Entry } from '../api'

export interface DirectoryCall {
  method: 'tree' | 'read' | 'write' | 'mkdir' | 'move' | 'remove'
  args: unknown[]
}

export interface MemoryDirectory {
  directory: Directory
  calls: DirectoryCall[]
  files: Map<string, Blob>
  dirs: Set<string>
  text: (path: string) => Promise<string>
}

interface MemoryOptions {
  files?: Record<string, string | Blob>
  dirs?: string[]
}

/** jsdom 的 Blob 没有读取接口，用 FileReader 取文本。 */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件内容失败。'))
    reader.readAsText(blob)
  })
}

function ancestors(path: string): string[] {
  const result: string[] = []
  let parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  while (parent) {
    result.push(parent)
    parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''
  }
  return result
}

/** 内存目录服务：按共享 Directory 契约实现，行为和限制与服务端一致。 */
export function createMemoryDirectory(options: MemoryOptions = {}): MemoryDirectory {
  const files = new Map<string, Blob>()
  for (const [path, value] of Object.entries(options.files ?? {})) {
    files.set(path, typeof value === 'string' ? new Blob([value], { type: 'text/plain' }) : value)
  }
  const dirs = new Set(options.dirs ?? [])
  const calls: DirectoryCall[] = []

  function allDirs(): Set<string> {
    const result = new Set(dirs)
    for (const path of [...files.keys(), ...dirs]) {
      for (const parent of ancestors(path)) result.add(parent)
    }
    return result
  }

  function describe(data: Blob | string): string {
    return typeof data === 'string' ? data : '<blob>'
  }

  const directory: Directory = {
    async tree() {
      calls.push({ method: 'tree', args: [] })
      const entries: Entry[] = []
      for (const dir of allDirs()) entries.push({ path: dir, kind: 'dir' })
      for (const [path, blob] of files) entries.push({ path, kind: 'file', size: blob.size })
      return entries
    },
    async read(path) {
      calls.push({ method: 'read', args: [path] })
      const blob = files.get(path)
      if (!blob) throw new Error(`未找到 ${path}`)
      return blob
    },
    async write(path, data, replace = false) {
      calls.push({ method: 'write', args: [path, describe(data), replace] })
      if (!replace && (files.has(path) || allDirs().has(path))) throw new Error(`已存在 ${path}`)
      files.set(path, typeof data === 'string' ? new Blob([data], { type: 'text/plain' }) : data)
    },
    async mkdir(path) {
      calls.push({ method: 'mkdir', args: [path] })
      if (allDirs().has(path) || files.has(path)) throw new Error(`已存在 ${path}`)
      dirs.add(path)
    },
    async move(from, to) {
      calls.push({ method: 'move', args: [from, to] })
      if (files.has(to) || allDirs().has(to)) throw new Error(`已存在 ${to}`)
      const prefix = `${from}/`
      for (const [path, blob] of [...files.entries()]) {
        if (path !== from && !path.startsWith(prefix)) continue
        files.delete(path)
        files.set(to + path.slice(from.length), blob)
      }
      for (const dir of [...allDirs()]) {
        if (dir !== from && !dir.startsWith(prefix)) continue
        dirs.delete(dir)
        dirs.add(to + dir.slice(from.length))
      }
    },
    async remove(path) {
      calls.push({ method: 'remove', args: [path] })
      const prefix = `${path}/`
      files.delete(path)
      for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key)
      for (const dir of [...allDirs()]) if (dir === path || dir.startsWith(prefix)) dirs.delete(dir)
    },
  }

  return {
    directory,
    calls,
    files,
    dirs,
    text: async (path) => {
      const blob = files.get(path)
      if (!blob) throw new Error(`未找到 ${path}`)
      return blobText(blob)
    },
  }
}

/** 测试宿主：呈现共享通知与确认弹窗，业务组件只发起请求。 */
export function FeedbackHost() {
  const confirmation = useFeedbackStore(state => state.confirmation)
  const finish = useFeedbackStore(state => state.finishConfirmation)
  const toasts = useFeedbackStore(state => state.toasts)
  return (
    <>
      {confirmation && (
        <div role="group" aria-label={confirmation.title}>
          <p>{confirmation.description}</p>
          <button type="button" onClick={() => finish(true)}>{confirmation.confirmLabel ?? '确认'}</button>
          <button type="button" onClick={() => finish(false)}>取消</button>
        </div>
      )}
      <div aria-live="polite">
        {toasts.map(toast => <p key={toast.id} role="status">{toast.message}</p>)}
      </div>
    </>
  )
}

export function resetFeedback() {
  useFeedbackStore.getState().finishConfirmation(false)
  useFeedbackStore.setState({ toasts: [], confirmation: null })
}

export function mountExplorer(props: ExplorerProps) {
  const user = userEvent.setup()
  const router = createMemoryRouter(
    [{ path: '*', element: <><Explorer {...props} /><FeedbackHost /></> }],
    { initialEntries: ['/'] },
  )
  const view = render(<RouterProvider router={router} />)
  return { user, router, ...view }
}

export function makeFile(name: string, content: string, relativePath?: string): File {
  const file = new File([content], name, { type: 'text/plain' })
  if (relativePath !== undefined) {
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  }
  return file
}
