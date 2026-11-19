import type { Directory, Entry } from '@/modules/directories/api'

export interface MemoryWrite {
  path: string
  content: string
  replace: boolean
}

export interface MemoryDirectory extends Directory {
  files: Map<string, string>
  /** 通过目录 API 新建的目录。 */
  created: string[]
  writes: MemoryWrite[]
  removed: string[]
}

function ancestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** 测试用的内存目录：路径都是包根相对路径，行为与 v2 目录接口一致。 */
export function memoryDirectory(files: Record<string, string>, dirs: string[] = []): MemoryDirectory {
  const contents = new Map(Object.entries(files))
  const directories = new Set<string>(dirs)
  const created: string[] = []
  const writes: MemoryWrite[] = []
  const removed: string[] = []

  const exists = (path: string) => contents.has(path) || directories.has(path)

  return {
    files: contents,
    created,
    writes,
    removed,
    async tree(): Promise<Entry[]> {
      const entries = new Map<string, Entry>()
      const add = (path: string, kind: Entry['kind'], size?: number) => {
        for (const dir of ancestors(path)) entries.set(dir, { path: dir, kind: 'dir' })
        entries.set(path, size === undefined ? { path, kind } : { path, kind, size })
      }
      for (const [path, text] of contents) add(path, 'file', new TextEncoder().encode(text).length)
      for (const path of directories) add(path, 'dir')
      return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
    },
    async read(path) {
      const text = contents.get(path)
      if (text === undefined) throw new Error(`文件不存在：${path}`)
      // jsdom 的 Blob 没有 text()/arrayBuffer()，这里给出与浏览器一致的最小实现。
      return {
        size: new TextEncoder().encode(text).length,
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      } as unknown as Blob
    },
    async write(path, data, replace = false) {
      if (!replace && exists(path)) throw new Error(`已存在：${path}`)
      const text = typeof data === 'string' ? data : await data.text()
      writes.push({ path, content: text, replace })
      contents.set(path, text)
    },
    async mkdir(path) {
      if (exists(path)) throw new Error(`已存在：${path}`)
      created.push(path)
      directories.add(path)
    },
    async move(from, to) {
      if (exists(to)) throw new Error(`已存在：${to}`)
      const text = contents.get(from)
      if (text === undefined) throw new Error(`文件不存在：${from}`)
      contents.delete(from)
      contents.set(to, text)
    },
    async remove(path) {
      removed.push(path)
      contents.delete(path)
      directories.delete(path)
    },
  }
}
