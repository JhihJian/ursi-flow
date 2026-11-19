import type { MouseEvent as ReactMouseEvent } from 'react'

import { cn } from '@/shared/lib/utils'
import { Icon } from '@/shared/ui/icon'

import type { TreeRow } from './tree'
import type { CtxTarget } from './use-explorer'

export interface CreateDraft {
  dir: string
  kind: 'file' | 'folder'
}

export interface ExplorerTreeProps {
  rows: TreeRow[]
  base: string
  expanded: ReadonlySet<string>
  activePath: string | null
  selected: string
  compact: boolean
  loading: boolean
  error: string
  renaming: string | null
  renameName: string
  creating: CreateDraft | null
  createName: string
  onRetry: () => void
  onToggleDir: (path: string) => void
  onOpen: (path: string) => void
  onSelect: (path: string) => void
  onRowContext: (event: ReactMouseEvent, target: CtxTarget, point?: { x: number; y: number }) => void
  onBlankContext: (event: ReactMouseEvent) => void
  onStartRename: (row: TreeRow) => void
  onRenameName: (value: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
  onCreateName: (value: string) => void
  onCommitCreate: () => void
  onCancelCreate: () => void
  onCreateFileIn: (row: TreeRow) => void
  onCreateFolderIn: (row: TreeRow) => void
  onDelete: (row: TreeRow) => void
}

function Indent({ depth }: { depth: number }) {
  return (
    <span className="flex shrink-0" style={{ width: `${8 + depth * 12}px` }} aria-hidden="true">
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} className="ml-[5px] w-[7px] border-l border-line/60" />
      ))}
    </span>
  )
}

/** 新建条目输入行：出现在根或目标目录正下方，回车确认，Esc 取消。 */
function CreateRow({ draft, base, depth, value, onChange, onCommit, onCancel }: {
  draft: CreateDraft
  base: string
  depth: number
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const atRoot = draft.dir === base
  return (
    <div className="flex w-full items-center gap-1 py-[3px] pr-1.5">
      {atRoot ? <span className="flex shrink-0" style={{ width: '8px' }} /> : <Indent depth={depth} />}
      <Icon
        name={draft.kind === 'folder' ? 'folder' : 'doc'}
        size={13}
        className={draft.kind === 'folder' ? 'text-accent-2' : 'text-txt3'}
      />
      <input
        autoFocus
        data-create
        aria-label={draft.kind === 'folder' ? '新目录名称' : '新文件名称'}
        className="min-w-0 flex-1 rounded border border-accent bg-surface px-1 py-0 font-mono text-[12px] text-txt outline-none"
        placeholder={draft.kind === 'folder' ? '目录名' : '文件名，可用 a/b.md 建子目录'}
        value={value}
        onChange={event => onChange(event.target.value)}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); onCommit() }
          if (event.key === 'Escape') { event.preventDefault(); onCancel() }
        }}
        onBlur={onCommit}
      />
    </div>
  )
}

/** 文件树：目录在前、按名称排序，行内可重命名，悬停出现操作按钮。 */
export function ExplorerTree(props: ExplorerTreeProps) {
  const {
    rows, base, expanded, activePath, selected, compact, loading, error,
    renaming, renameName, creating, createName,
  } = props
  const rootCreate = creating && creating.dir === base ? creating : null
  const actionClass = 'shrink-0 text-txt3 opacity-0 transition-opacity hover:text-accent-2 group-hover:opacity-100 focus-visible:opacity-100'

  return (
    <div
      className="scroll-area min-h-0 flex-1 overflow-y-auto py-1"
      data-testid="explorer-tree"
      onContextMenu={props.onBlankContext}
    >
      {loading && !rows.length && <div className="px-3 py-6 text-center text-[11px] text-txt3">正在读取文件列表…</div>}
      {error && (
        <div className="space-y-2 px-3 py-4 text-center text-[11px] leading-5 text-err" role="alert">
          <p className="break-words">{error}</p>
          <button type="button" className="text-accent-2 underline" onClick={props.onRetry}>重试</button>
        </div>
      )}
      {!loading && !error && !rows.length && !creating && (
        <div className="px-3 py-6 text-center text-[11px] leading-5 text-txt3">目录为空，可新建文件或导入目录。</div>
      )}

      {rootCreate && (
        <CreateRow
          draft={rootCreate}
          base={base}
          depth={0}
          value={createName}
          onChange={props.onCreateName}
          onCommit={props.onCommitCreate}
          onCancel={props.onCancelCreate}
        />
      )}

      {rows.map(row => {
        const target: CtxTarget = { dir: row.dir, path: row.path, name: row.name }
        const isActive = !row.dir && activePath === row.path
        const createHere = creating && creating.dir === row.path ? creating : null
        return (
          <div key={row.path}>
            <div
              data-testid="explorer-row"
              data-path={row.path}
              data-dir={row.dir ? 'true' : 'false'}
              className={cn(
                'group relative flex w-full items-center gap-1 pr-1.5 text-left text-[12px] transition-colors',
                compact ? 'min-h-11 py-2' : 'py-[3px]',
                isActive ? 'bg-accent-dim text-txt' : 'text-txt2 hover:bg-elevated',
                selected === row.path && !isActive && 'bg-elevated/60',
              )}
              onDoubleClick={() => props.onStartRename(row)}
              onContextMenu={event => props.onRowContext(event, target)}
            >
              {isActive && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden="true" />}
              <Indent depth={row.depth} />

              {renaming === row.path ? (
                <>
                  <Icon name={row.dir ? 'folder' : 'doc'} size={13} className={row.dir ? 'text-accent-2' : 'text-txt3'} />
                  <input
                    autoFocus
                    data-rename
                    aria-label="重命名"
                    title="只输入文件名可改名，输入 a/b.md 可移动到其他目录"
                    className="min-w-0 flex-1 rounded border border-accent bg-surface px-1 py-0 font-mono text-[12px] text-txt outline-none"
                    value={renameName}
                    onChange={event => props.onRenameName(event.target.value)}
                    onClick={event => event.stopPropagation()}
                    onKeyDown={event => {
                      if (event.key === 'Enter') { event.preventDefault(); props.onCommitRename() }
                      if (event.key === 'Escape') { event.preventDefault(); props.onCancelRename() }
                    }}
                    onBlur={props.onCommitRename}
                  />
                </>
              ) : row.dir ? (
                <>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                    aria-expanded={expanded.has(row.path)}
                    onClick={() => props.onToggleDir(row.path)}
                  >
                    <Icon name={expanded.has(row.path) ? 'chevron-down' : 'chevron-right'} size={12} className="text-txt3" />
                    <Icon name="folder" size={13} className="text-accent-2" />
                    <span className="truncate font-mono">{row.name}</span>
                  </button>
                  {compact ? (
                    <button
                      type="button"
                      data-testid="row-more"
                      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center text-txt3"
                      title="更多操作"
                      aria-label={`${row.name} 的更多操作`}
                      onClick={event => {
                        const rect = event.currentTarget.getBoundingClientRect()
                        props.onRowContext(event, target, { x: rect.right, y: rect.bottom })
                      }}
                    >
                      <Icon name="more-horizontal" size={16} />
                    </button>
                  ) : (
                    <>
                      <button type="button" className={cn(actionClass, 'h-4 w-4')} title="在此新建文件" aria-label={`在 ${row.name} 新建文件`}
                        onClick={() => props.onCreateFileIn(row)}>
                        <Icon name="doc" size={12} />
                      </button>
                      <button type="button" className={cn(actionClass, 'h-4 w-4')} title="在此新建文件夹" aria-label={`在 ${row.name} 新建文件夹`}
                        onClick={() => props.onCreateFolderIn(row)}>
                        <Icon name="folder" size={12} />
                      </button>
                      <button type="button" className={cn(actionClass, 'h-4 w-4')} title="重命名" aria-label={`重命名 ${row.name}`}
                        onClick={event => { event.stopPropagation(); props.onStartRename(row) }}>
                        <Icon name="edit" size={12} />
                      </button>
                      <button type="button" className={cn(actionClass, 'h-4 w-4 hover:text-err')} title="删除" aria-label={`删除 ${row.name}`}
                        onClick={event => { event.stopPropagation(); props.onDelete(row) }}>
                        <Icon name="close" size={12} />
                      </button>
                    </>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 pl-[15px] text-left"
                    onClick={() => { props.onSelect(row.path); props.onOpen(row.path) }}
                  >
                    <Icon name="doc" size={13} className="text-txt3" />
                    <span className="truncate font-mono">{row.name}</span>
                  </button>
                  {compact ? (
                    <button
                      type="button"
                      data-testid="row-more"
                      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center text-txt3"
                      title="更多操作"
                      aria-label={`${row.name} 的更多操作`}
                      onClick={event => {
                        const rect = event.currentTarget.getBoundingClientRect()
                        props.onRowContext(event, target, { x: rect.right, y: rect.bottom })
                      }}
                    >
                      <Icon name="more-horizontal" size={16} />
                    </button>
                  ) : (
                    <>
                      <button type="button" className={cn(actionClass, 'h-4 w-4')} title="重命名" aria-label={`重命名 ${row.name}`}
                        onClick={event => { event.stopPropagation(); props.onStartRename(row) }}>
                        <Icon name="edit" size={12} />
                      </button>
                      <button type="button" className={cn(actionClass, 'h-4 w-4 hover:text-err')} title="删除" aria-label={`删除 ${row.name}`}
                        onClick={event => { event.stopPropagation(); props.onDelete(row) }}>
                        <Icon name="close" size={12} />
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
            {createHere && (
              <CreateRow
                draft={createHere}
                base={base}
                depth={row.depth + 1}
                value={createName}
                onChange={props.onCreateName}
                onCommit={props.onCommitCreate}
                onCancel={props.onCancelCreate}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
