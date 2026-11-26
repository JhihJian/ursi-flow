/**
 * 会话运行态：本模块不采集心跳，只接收宿主注入的来源。
 *
 * 结构类型由本模块自己声明，不 import 采集方的任何类型；宿主只要传一个
 * 形状匹配的函数即可。会话文件路径是唯一的匹配键。
 */
export interface LiveSessionInfo {
  sessionId: string
  /** 绝对路径；采集方负责归一化。为空表示会话还没写入文件。 */
  sessionFile: string | null
  parentSessionFile: string | null
  cwd: string
  name: string | null
  model: string | null
  mode: string
  status: 'running' | 'idle'
  host: string
  /** 是否来自本机；跨机条目的会话文件在本机读不到。 */
  sameHost: boolean
  pid: number
  startedAt: number
  updatedAt: number
}

export interface LiveSessionFeed {
  sessions: LiveSessionInfo[]
  stale: number
  warnings: string[]
  now: number
}

export interface LiveSessionSource {
  fetch: () => Promise<LiveSessionFeed>
}

/** 运行态按会话文件绝对路径索引：磁盘行与运行态靠它对齐。 */
export function indexLiveByFile(feed: LiveSessionFeed | null): Map<string, LiveSessionInfo[]> {
  const map = new Map<string, LiveSessionInfo[]>()
  for (const session of feed?.sessions ?? []) {
    if (!session.sessionFile) continue
    const key = normalizePath(session.sessionFile)
    const list = map.get(key)
    if (list) list.push(session)
    else map.set(key, [session])
  }
  return map
}

/** 只做字符串归一化，不 realpath：文件刚创建时 realpath 会失败。 */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  return trimmed.startsWith('~') ? trimmed : trimmed
}

/** 一个磁盘行可能对应多条运行态（子会话共享父会话文件），取正在运行的那条。 */
export function primaryLive(list: LiveSessionInfo[] | undefined): LiveSessionInfo | null {
  if (!list || list.length === 0) return null
  return list.find((item) => item.status === 'running') ?? list[0]
}
