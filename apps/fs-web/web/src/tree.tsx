import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronRight,
  File as FileIcon,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
} from 'lucide-react'
import { keyName, keySegments } from './api.ts'
import { flattenOpen, useTreeStore } from './tree-store.ts'
import { badgeMapOf, useGitStore } from './git-store.ts'
import { ContextMenu, type MenuItem, type MenuState } from './context-menu.tsx'
import type { TreeRowData } from './tree-store.ts'

type OpenMenu = (x: number, y: number, items: MenuItem[], heading?: string) => void

interface TreeProps {
  onOpenFile: (key: string) => void
  /** 文件删除成功后回调（宿主清理编辑视图）。 */
  onFileDeleted: (key: string) => void
  /** 新建文件夹（在当前选中目录下，展示底部内联输入）。 */
  onCreateDir: () => void
}

/** FileKey → 相对 workspace 的正斜杠路径，与 git 变更列表对齐。 */
function rowRelPathOf(workspaceId: string, key: string): string {
  return keySegments(key).path.join('/')
}

/** 状态徽标：目录显示聚合数，文件显示状态字母。 */
function GitBadge({ badge }: { badge: { code: string; count?: number } | null }) {
  if (!badge) return null
  return (
    <span className="wsx-git-badge" title={`git: ${badge.code}`} aria-hidden="true">
      {badge.count !== undefined ? badge.count : badge.code}
    </span>
  )
}

/** 行首图标尺寸与缩进：目录每深一层 16px，行内边距 8px（对齐外壳侧栏）。 */
const ICON_SIZE = 12
const ROW_INDENT = 16

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])
const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'log', 'csv'])
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'less', 'html', 'py', 'rs', 'go',
  'java', 'c', 'h', 'cpp', 'sh', 'bash', 'zsh', 'sql', 'rb', 'php', 'lua', 'kt', 'swift',
])
const DATA_EXTS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'lock'])

/** 文件行首图标：按扩展名分四类，其余用通用文件图标（orca 文件树的同款做法）。 */
function FileKindIcon({ name }: { name: string }) {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const Icon = IMAGE_EXTS.has(ext)
    ? FileImage
    : TEXT_EXTS.has(ext)
      ? FileText
      : CODE_EXTS.has(ext)
        ? FileCode
        : DATA_EXTS.has(ext)
          ? FileJson
          : FileIcon
  return <Icon className="wsx-tree-icon" size={ICON_SIZE} aria-hidden="true" />
}

/** 窄栏文件树：目录 + 文件行统一虚拟化。目录点击折叠/展开，文件点击打开；右键菜单操作。 */
export function FileTree({ onOpenFile, onFileDeleted, onCreateDir }: TreeProps) {
  const dirs = useTreeStore((state) => state.dirs)
  const openDirs = useTreeStore((state) => state.openDirs)
  const selectedDirKey = useTreeStore((state) => state.selectedDirKey)
  const toggleDir = useTreeStore((state) => state.toggleDir)
  const selectDir = useTreeStore((state) => state.selectDir)
  const renameEntry = useTreeStore((state) => state.renameEntry)
  const removeEntry = useTreeStore((state) => state.removeEntry)
  const workspaceId = useTreeStore((state) => state.activeWorkspaceId)
  const refreshAll = useTreeStore((state) => state.refreshAll)
  const openTerminal = useTreeStore((state) => state.host.openTerminal)
  const locationOf = useTreeStore((state) => state.locationOf)
  const reportError = useTreeStore((state) => state.reportError)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const openMenu: OpenMenu = (x, y, items, heading) => setMenu({ x, y, items, heading })

  const rows = useMemo(() => flattenOpen(openDirs, dirs), [openDirs, dirs])
  const snapshot = useGitStore((state) => state.snapshot)
  const badges = useMemo(
    () => (snapshot && workspaceId ? badgeMapOf(snapshot.changes) : null),
    [snapshot, workspaceId],
  )
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 12,
  })

  const submitRename = async (key: string, name: string): Promise<void> => {
    setEditingKey(null)
    if (!name.trim() || name === keyName(key)) return
    await renameEntry(key, name.trim())
  }

  /** 行右键菜单：刷新、新建文件夹、重命名、删除（删除走菜单内确认行）。 */
  const rowMenu = (row: TreeRowData, x: number, y: number): void => {
    selectDir(row.key)
    const isRoot = rows[0]?.key === row.key
    const items: MenuItem[] = [
      { label: '刷新', onSelect: () => void refreshAll() },
      { label: '新建文件夹', onSelect: onCreateDir },
    ]
    // 远程目录才有「在此打开终端」：本机终端不归 ssh-web 管，宿主没接线时也不显示。
    const location = locationOf(row.key)
    if (openTerminal && location?.scheme === 'ssh' && location.device) {
      items.push({
        label: '在此打开终端',
        onSelect: () => {
          openTerminal({ device: location.device!, cwd: location.path }).catch((error: unknown) =>
            reportError(error instanceof Error ? error.message : String(error)),
          )
        },
      })
    }
    if (!isRoot) {
      items.push({ label: '重命名', onSelect: () => setEditingKey(row.key) })
      items.push({
        label: '删除',
        danger: true,
        onSelect: () => {
          const label = row.kind === 'dir' ? '目录内容将被递归删除' : '文件将直接删除'
          const confirmItems: MenuItem[] = [
            {
              label: '删除',
              danger: true,
              onSelect: () => {
                void removeEntry(row.key)
                if (row.kind === 'file') onFileDeleted(row.key)
              },
            },
            { label: '取消', onSelect: () => {} },
          ]
          openMenu(x, y, confirmItems, `删除「${keyName(row.key)}」？${label}，不可恢复。`)
        },
      })
    }
    openMenu(x, y, items)
  }

  return (
    <>
      <div ref={parentRef} className="wsx-tree" style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!
            const selected = selectedDirKey === row.key || editingKey === row.key
            const badge = badges?.get(rowRelPathOf(workspaceId!, row.key)) ?? null
            return (
              <div
                key={row.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className={'wsx-tree-row' + (selected ? ' wsx-tree-row--selected' : '')}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 4,
                  right: 4,
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingLeft: row.depth * ROW_INDENT,
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  rowMenu(row, event.clientX, event.clientY)
                }}
              >
                {editingKey === row.key ? (
                  <RowRenameInput initial={keyName(row.key)} onDone={(name) => void submitRename(row.key, name)} />
                ) : (
                  <button
                    type="button"
                    className="wsx-tree-row-main"
                    onClick={() => {
                      selectDir(row.key)
                      if (row.kind === 'dir') void toggleDir(row.key)
                      else onOpenFile(row.key)
                    }}
                    onDoubleClick={() => setEditingKey(row.key)}
                    aria-expanded={row.kind === 'dir' ? row.isOpen : undefined}
                    title={badge ? `${keyName(row.key)} · git ${badge.code}` : keyName(row.key)}
                  >
                    <span className="wsx-tree-caret">
                      {row.kind === 'dir' ? (
                        <ChevronRight
                          className={row.isOpen ? 'wsx-tree-chevron wsx-tree-chevron--open' : 'wsx-tree-chevron'}
                          size={ICON_SIZE}
                          aria-hidden="true"
                        />
                      ) : null}
                    </span>
                    {row.kind === 'dir' ? (
                      row.isOpen ? (
                        <FolderOpen className="wsx-tree-icon" size={ICON_SIZE} aria-hidden="true" />
                      ) : (
                        <Folder className="wsx-tree-icon" size={ICON_SIZE} aria-hidden="true" />
                      )
                    ) : (
                      <FileKindIcon name={keyName(row.key)} />
                    )}
                    <span className={'wsx-tree-name' + (row.kind === 'dir' ? '' : ' wsx-tree-name--file')}>
                      {keyName(row.key)}
                    </span>
                    {badges ? <GitBadge badge={badge} /> : null}
                    {row.kind === 'dir' && dirs[row.key]?.status === 'loading' ? (
                      <span className="wsx-tree-loading" role="status" aria-label="正在加载">
                        <Loader2 className="wsx-spin" size={ICON_SIZE} aria-hidden="true" />
                      </span>
                    ) : null}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </>
  )
}

function RowRenameInput({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <input
      className="wsx-tree-rename"
      value={value}
      autoFocus
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onDone(value)
        if (event.key === 'Escape') onDone(initial)
      }}
    />
  )
}
