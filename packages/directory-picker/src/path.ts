import type { DirEntry } from './types'

/**
 * 路径纯函数。只处理 POSIX 形态；解析、校验与规范化都在服务端，
 * 客户端只做「从规范路径推下一层路径」和「输入分类」两件事。
 */

/** 规范路径 + 子目录名 → 子目录路径。`path` 必须来自服务端，根为 `/`。 */
export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** 输入分类：含 `/`（或 `~`、`.` 开头）当路径导航，否则当当前列表的过滤词。 */
export function classifyInput(raw: string): 'path' | 'filter' {
  if (raw.includes('/') || raw === '~' || raw === '.' || raw === '..') return 'path'
  return 'filter'
}

/** 过滤当前列表：子串匹配，大小写不敏感；空串返回全部。不重排。 */
export function filterEntries(entries: DirEntry[], filter: string): DirEntry[] {
  const keyword = filter.trim().toLowerCase()
  if (!keyword) return entries
  return entries.filter((entry) => entry.name.toLowerCase().includes(keyword))
}

/** 面包屑分段：`/a/b/c` → [{name:'a',path:'/a'},{name:'b',path:'/a/b'},{name:'c',path:'/a/b/c'}]。 */
export function pathSegments(dir: string): { name: string; path: string }[] {
  if (dir === '/' || dir === '') return []
  return dir
    .slice(1)
    .split('/')
    .map((name, index, parts) => ({
      name,
      path: `/${parts.slice(0, index + 1).join('/')}`,
    }))
}
