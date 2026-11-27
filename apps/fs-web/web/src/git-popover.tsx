import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitBranchNodeDto } from '../../server/src/types.ts'
import { useMenuContainer } from './menu-container.ts'

/** git 摘要 chip 的弹出层：定位在锚点元素下方，点外部/Esc/滚动关闭。
 *  内容是一棵展开的树（分支树或变更文件树），行渲染由调用方给。
 *  和右键菜单一样 portal 进侧栏根（不滚动），坐标相对它，不用全局 position: fixed。 */

export interface PopoverTreeRow {
  key: string
  /** 显示名（路径末段）。 */
  name: string
  depth: number
  kind: 'dir' | 'branch' | 'change-file' | 'change-dir'
  /** 分支短 hash / 变更徽标字母。 */
  meta?: string
  current?: boolean
  /** 目录行的展开态（决定箭头）。 */
  open?: boolean
  /** 悬停提示（变更文件行放全路径）。 */
  title?: string
  onClick?: () => void
}

interface PopoverState {
  /** 锚点元素（chip），浮层定位其下。 */
  anchor: HTMLElement
  heading: string
  rows: PopoverTreeRow[]
  /** 可展开的目录行初始折叠集（key 集合）。 */
  loading?: boolean
}

export type { PopoverState as GitPopoverState }

const POPOVER_WIDTH = 260
const POPOVER_MAX_HEIGHT = 320
/** 上下都紧时至少给这个高度，宁可被容器底边裁一点也不缩成一条。 */
const POPOVER_MIN_HEIGHT = 120

/** 树数据 → 行列表；expanded 之外的目录行折叠。 */
export function flattenBranchNodes(
  nodes: GitBranchNodeDto[],
  expanded: Set<string>,
  depth = 0,
  path = '',
): PopoverTreeRow[] {
  const rows: PopoverTreeRow[] = []
  for (const node of nodes) {
    const key = path === '' ? node.name : `${path}/${node.name}`
    if (node.kind === 'dir') {
      rows.push({ key, name: node.name, depth, kind: 'dir', open: expanded.has(key) })
      if (expanded.has(key) && node.children) {
        rows.push(...flattenBranchNodes(node.children, expanded, depth + 1, key))
      }
    } else {
      rows.push({
        key,
        name: node.name,
        depth,
        kind: 'branch',
        meta: node.hash,
        current: node.current,
      })
    }
  }
  return rows
}

/** 变更条目（正斜杠路径 + 徽标）→ 树行；目录默认展开。 */
export function flattenChangeRows(
  entries: Array<{ path: string; badge: string; title?: string }>,
  expanded: Set<string>,
): PopoverTreeRow[] {
  interface TreeNode {
    name: string
    children: Map<string, TreeNode>
    badge?: string
    title?: string
  }
  const root: TreeNode = { name: '', children: new Map() }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const isLeaf = i === parts.length - 1
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, children: new Map() }
        node.children.set(part, child)
      }
      if (isLeaf) {
        child.badge = entry.badge
        child.title = entry.title
      }
      node = child
    }
  }

  const rows: PopoverTreeRow[] = []
  const walk = (node: TreeNode, depth: number, path: string): void => {
    const sorted = [...node.children.values()].sort((a, b) => {
      const aDir = a.children.size > 0
      const bDir = b.children.size > 0
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const child of sorted) {
      const key = path === '' ? child.name : `${path}/${child.name}`
      const isDir = child.children.size > 0
      rows.push({
        key,
        name: child.name,
        depth,
        kind: isDir ? 'change-dir' : 'change-file',
        meta: isDir ? undefined : (child.badge ?? 'M'),
        title: child.title,
        open: isDir ? expanded.has(key) : undefined,
      })
      if (isDir && expanded.has(key)) walk(child, depth + 1, key)
    }
  }
  walk(root, 0, '')
  return rows
}

export function GitPopover({
  state,
  onClose,
}: {
  state: PopoverState | null
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const container = useMenuContainer()
  const [position, setPosition] = useState<{ left: number; top: number; height: number } | null>(null)

  useLayoutEffect(() => {
    if (!state || !container) {
      setPosition(null)
      return
    }
    const host = container.getBoundingClientRect()
    const box = state.anchor.getBoundingClientRect()
    // 锚点相对侧栏根的坐标；上下都夹在容器内，下面放不下就翻到锚点上方。
    const left = Math.max(4, Math.min(box.left - host.left, host.width - POPOVER_WIDTH - 4))
    const below = host.height - (box.bottom - host.top) - 4
    const above = box.top - host.top - 4
    const height = Math.max(POPOVER_MIN_HEIGHT, Math.min(POPOVER_MAX_HEIGHT, below, above))
    const top = below >= height ? box.bottom - host.top + 4 : box.top - host.top - height - 4
    setPosition({ left, top, height })
  }, [state, container])

  useEffect(() => {
    if (!state) return
    const close = (): void => onClose()
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node)) return
      if (state.anchor.contains(event.target as Node)) return // 点锚点本身交给 chip 的 toggle
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onScroll = (event: Event): void => {
      // 页面滚动时跟随关闭；弹层自身的内滚不关
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [state, onClose])

  if (!state || !container || !position) return null

  return createPortal(
    <div
      ref={ref}
      className="wsx-git-popover"
      style={{
        left: position.left,
        top: position.top,
        width: POPOVER_WIDTH,
        maxHeight: position.height,
      }}
    >
      <div className="wsx-git-popover-heading">{state.heading}</div>
      <div className="wsx-git-popover-body">
        {state.rows.length === 0 ? (
          <div className="wsx-git-popover-empty">（空）</div>
        ) : (
          state.rows.map((row) => (
            <button
              key={row.key}
              type="button"
              className={
                'wsx-git-popover-row' +
                (row.current ? ' wsx-git-popover-row--current' : '') +
                (row.onClick ? '' : ' wsx-git-popover-row--static')
              }
              style={{ paddingLeft: 6 + row.depth * 12 }}
              title={row.title ?? row.key}
              onClick={() => {
                // 叶子动作行（打开文件）点击后收起；目录展开行保持弹层打开
                const isLeaf = row.kind === 'branch' || row.kind === 'change-file'
                row.onClick?.()
                if (isLeaf && row.onClick) onClose()
              }}
            >
              <span className="wsx-git-popover-caret">
                {row.kind === 'dir' || row.kind === 'change-dir' ? (row.open ? '▾' : '▸') : ''}
              </span>
              <span
                className={
                  'wsx-git-popover-name' +
                  (row.kind === 'branch' && !row.current ? ' wsx-git-popover-name--dim' : '')
                }
              >
                {row.name}
              </span>
              {row.meta ? <span className="wsx-git-popover-meta">{row.meta}</span> : null}
            </button>
          ))
        )}
      </div>
    </div>,
    container,
  )
}
