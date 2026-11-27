import type { DirEntry } from './types'

/**
 * 输入纯函数。位置的分段与派生（面包屑、进入子目录）由 `@ursi/location` 负责，
 * 这里只剩「输入分类」与「列表过滤」两件事，组件不自己拼路径字符串。
 */

/** 输入分类：含 `://`（位置 URI）、`/`（或 `~`、`.`、`..`）当路径导航，否则当当前列表的过滤词。 */
export function classifyInput(raw: string): 'path' | 'filter' {
  if (raw.includes('://') || raw.includes('/') || raw === '~' || raw === '.' || raw === '..') return 'path'
  return 'filter'
}

/** 过滤当前列表：子串匹配，大小写不敏感；空串返回全部。不重排。 */
export function filterEntries(entries: DirEntry[], filter: string): DirEntry[] {
  const keyword = filter.trim().toLowerCase()
  if (!keyword) return entries
  return entries.filter((entry) => entry.name.toLowerCase().includes(keyword))
}
