import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { keyName } from './api.ts'
import { flattenOpen, useTreeStore } from './tree-store.ts'
import type { TreeRowData } from './tree-store.ts'

interface TreeProps {
  onOpenFile: (key: string) => void
  /** 删除文件前的确认回调；返回是否继续删除。 */
  confirm: (message: string) => Promise<boolean>
  /** 行删除成功后回调（模块清理编辑视图）。 */
  onFileDeleted: (key: string) => void
}

/** 窄栏文件树：目录 + 文件行统一虚拟化。目录点击折叠/展开，文件点击打开；双击行内重命名。 */
export function FileTree({ onOpenFile, confirm, onFileDeleted }: TreeProps) {
  const dirs = useTreeStore((state) => state.dirs)
  const openDirs = useTreeStore((state) => state.openDirs)
  const selectedDirKey = useTreeStore((state) => state.selectedDirKey)
  const toggleDir = useTreeStore((state) => state.toggleDir)
  const selectDir = useTreeStore((state) => state.selectDir)
  const renameEntry = useTreeStore((state) => state.renameEntry)
  const removeEntry = useTreeStore((state) => state.removeEntry)
  const [editingKey, setEditingKey] = useState<string | null>(null)

  const rows = useMemo(() => flattenOpen(openDirs, dirs), [openDirs, dirs])
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 12,
  })

  const submitRename = async (key: string, name: string): Promise<void> => {
    setEditingKey(null)
    if (!name.trim() || name === keyName(key)) return
    await renameEntry(key, name.trim())
  }

  const deleteRow = async (row: TreeRowData): Promise<void> => {
    const ok = await confirm(`删除「${keyName(row.key)}」？${row.kind === 'dir' ? '目录内容将被递归删除' : '文件将直接删除'}，不可恢复。`)
    if (!ok) return
    await removeEntry(row.key)
    if (row.kind === 'file') onFileDeleted(row.key)
  }

  return (
    <div ref={parentRef} className="wsx-tree" style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]!
          const selected = selectedDirKey === row.key || editingKey === row.key
          return (
            <div
              key={row.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className={'wsx-tree-row' + (selected ? ' wsx-tree-row--selected' : '')}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                paddingLeft: 8 + row.depth * 14,
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
                  title={keyName(row.key)}
                >
                  <span className="wsx-tree-caret">{row.kind === 'dir' ? (row.isOpen ? '▾' : '▸') : ''}</span>
                  <span className={'wsx-tree-name' + (row.kind === 'dir' ? '' : ' wsx-tree-name--file')}>
                    {keyName(row.key)}
                  </span>
                  {row.kind === 'dir' && dirs[row.key]?.status === 'loading' ? (
                    <span className="wsx-tree-loading">…</span>
                  ) : null}
                </button>
              )}
              <button
                type="button"
                className="wsx-tree-row-delete"
                title="删除"
                onClick={() => void deleteRow(row)}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </div>
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
