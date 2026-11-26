import type { SessionRow } from '@/api'

export interface SessionGroup {
  key: string
  name: string
  sessions: SessionRow[]
  /** 组内最新活动时间，组按它倒序 */
  newest: number
}

/** 一条会话显示什么名字：改名优先，其次首条用户消息，最后退到 id。 */
export function sessionTitle(row: SessionRow): string {
  const name = row.name?.trim()
  if (name) return name
  const first = row.firstMessage.replace(/\s+/g, ' ').trim()
  if (first) return first.length > 80 ? `${first.slice(0, 80).trimEnd()}…` : first
  return row.id.slice(0, 12)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 相对时间：一分钟内算现在，一天内按分钟/小时，一周内按天，
 * 再往前直接给日期。会话列表里「多久以前」比精确时刻更好扫读。
 */
export function formatAge(modified: number, now: number = Date.now()): string {
  if (!Number.isFinite(modified)) return '—'
  const elapsed = now - modified
  if (elapsed < MINUTE) return '刚刚'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} 天前`
  const date = new Date(modified)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return sameYear ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`
}

/** 精确时刻固定成 `YYYY-MM-DD HH:mm`：等宽字体下对齐，且不受浏览器语言影响。 */
export function formatWhen(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  const pad = (value: number) => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 默认折叠哪些组：第一个组和包含选中会话的组展开，其余收起。
 * 会话可能有上千条，一次全展开会让侧栏长到无法扫读。
 */
export function defaultFoldedGroups(
  groups: readonly SessionGroup[],
  selectedId: string | null,
): Set<string> {
  const folded = new Set<string>()
  groups.forEach((group, index) => {
    const open = index === 0 || (selectedId !== null && group.sessions.some((row) => row.id === selectedId))
    if (!open) folded.add(group.key)
  })
  return folded
}

/** 行下方的次要信息：消息数与体积，明细还没读到时给省略号。 */
export function sessionMeta(row: SessionRow): string {
  const count = row.detailsPending ? '…' : `${row.messageCount} 条`
  return `${count} · ${formatBytes(row.size)}`
}

/** 搜索按空格分词，每个词都要命中标题、首条消息、项目路径或 id。 */
export function matchesQuery(row: SessionRow, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [sessionTitle(row), row.firstMessage, row.projectName, row.cwd, row.projectDir, row.id, row.name ?? '']
    .join(' ')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/**
 * 按项目分组：组按组内最新活动倒序，组内会话同样倒序，命不中搜索的会话和
 * 因此空掉的组都不出现。
 */
export function groupSessions(rows: readonly SessionRow[], query = ''): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const row of rows) {
    if (!matchesQuery(row, query)) continue
    const group = groups.get(row.projectKey)
    if (group) {
      group.sessions.push(row)
      group.newest = Math.max(group.newest, row.modified)
    } else {
      groups.set(row.projectKey, {
        key: row.projectKey,
        name: row.projectName,
        sessions: [row],
        newest: row.modified,
      })
    }
  }
  const list = [...groups.values()]
  for (const group of list) group.sessions.sort((a, b) => b.modified - a.modified)
  list.sort((a, b) => b.newest - a.newest || a.name.localeCompare(b.name))
  return list
}

/** 当前选中会话所在的组，折叠侧边栏时用它的最新会话做一行摘要。 */
export function groupOfKey(groups: readonly SessionGroup[], key: string | null): SessionGroup | null {
  if (!key) return null
  return groups.find((group) => group.key === key) ?? null
}

/** 根路径的显示形式：保留末两段，前面用 … 省略，避免长路径挤掉会话列表。 */
export function shortRoot(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return trimmed || root
  return `…/${parts.slice(-2).join('/')}`
}
