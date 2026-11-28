/**
 * 会话运行态的派生：本模块不采集心跳，运行态随会话清单一起到达。
 *
 * 服务端把本进程装配的运行时与其它进程的心跳合流后挂在每条实体上，
 * 侧栏按会话文件路径再索引一次，供绿点、模型名与存活计数使用。
 */
import type { SessionRow, SessionRuntime } from './api'

/** 运行态按会话文件绝对路径索引：没落盘的会话没有路径，不进索引。 */
export function indexRuntimesByFile(rows: readonly SessionRow[]): Map<string, SessionRuntime[]> {
  const map = new Map<string, SessionRuntime[]>()
  for (const row of rows) {
    if (!row.path || row.runtimes.length === 0) continue
    const key = normalizePath(row.path)
    const list = map.get(key)
    if (list) list.push(...row.runtimes)
    else map.set(key, [...row.runtimes])
  }
  return map
}

/** 只做字符串归一化，不 realpath：文件刚创建时 realpath 会失败。 */
export function normalizePath(path: string): string {
  return path.trim().replace(/\/+$/, '')
}

/** 一个磁盘行可能对应多条运行态（子会话共享父会话文件），取正在运行的那条。 */
export function primaryRuntime(list: readonly SessionRuntime[] | undefined): SessionRuntime | null {
  if (!list || list.length === 0) return null
  return list.find((item) => item.status === 'running') ?? list[0]
}
