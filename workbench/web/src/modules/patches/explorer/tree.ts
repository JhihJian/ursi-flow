import { isWithin, normalizePath } from './paths'
import type { Entry } from '@/modules/directories/api'

export interface TreeNode {
  name: string
  /** 包根相对路径；root 节点是限定范围内的前缀。 */
  path: string
  dir: boolean
  children: TreeNode[]
}

export interface TreeRow {
  name: string
  path: string
  dir: boolean
  depth: number
  size?: number
}

/**
 * 由全树扁平清单构建目录树。`root` 只限定显示范围，
 * 节点路径仍然是包根相对路径，目录 API 调用不受影响。
 */
export function buildTree(entries: Entry[], root = ''): TreeNode {
  const base = normalizePath(root)
  const tree: TreeNode = { name: base ? base.slice(base.lastIndexOf('/') + 1) : '', path: base, dir: true, children: [] }
  const index = new Map<string, TreeNode>([[base, tree]])

  const ordered = [...entries].sort((left, right) => left.path.length - right.path.length)
  for (const entry of ordered) {
    const path = normalizePath(entry.path)
    if (!path || path === base || !isWithin(path, base)) continue
    const segments = base ? path.slice(base.length + 1).split('/') : path.split('/')
    let current = tree
    let accumulated = base
    segments.forEach((segment, position) => {
      const parentPrefix = accumulated
      accumulated = parentPrefix ? `${parentPrefix}/${segment}` : segment
      const leaf = position === segments.length - 1
      let child = index.get(accumulated)
      if (!child) {
        child = {
          name: segment,
          path: accumulated,
          dir: leaf ? entry.kind === 'dir' : true,
          children: [],
        }
        index.set(accumulated, child)
        current.children.push(child)
      }
      current = child
    })
  }
  sortTree(tree)
  return tree
}

function sortTree(node: TreeNode) {
  node.children.sort((left, right) => left.dir === right.dir
    ? left.name.localeCompare(right.name)
    : left.dir ? -1 : 1)
  for (const child of node.children) sortTree(child)
}

/** 按展开状态压平成可见行，行为与文件树一致：目录在前，按名称排序。 */
export function visibleRows(tree: TreeNode, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (node: TreeNode, depth: number) => {
    for (const child of node.children) {
      rows.push({ name: child.name, path: child.path, dir: child.dir, depth })
      if (child.dir && expanded.has(child.path)) walk(child, depth + 1)
    }
  }
  walk(tree, 0)
  return rows
}

/** 打开文件时展开其全部祖先目录。 */
export function ancestorsOf(path: string, root = ''): string[] {
  const base = normalizePath(root)
  const relative = base ? path.slice(base.length + 1) : path
  const segments = relative.split('/').filter(Boolean)
  const result: string[] = []
  let accumulated = base
  for (let position = 0; position < segments.length - 1; position++) {
    accumulated = accumulated ? `${accumulated}/${segments[position]}` : segments[position]!
    result.push(accumulated)
  }
  return result
}

export function treePaths(tree: TreeNode): { files: Set<string>; dirs: Set<string> } {
  const files = new Set<string>()
  const dirs = new Set<string>()
  const walk = (node: TreeNode) => {
    for (const child of node.children) {
      if (child.dir) dirs.add(child.path)
      else files.add(child.path)
      walk(child)
    }
  }
  walk(tree)
  return { files, dirs }
}

/** 目录导入/新建嵌套文件前，按深度补齐缺少的父目录。 */
export function missingAncestors(path: string, root: string, existingDirs: ReadonlySet<string>): string[] {
  const base = normalizePath(root)
  return ancestorsOf(path, base).filter(dir => dir !== base && !existingDirs.has(dir))
}
