import { cn } from '@/shared/lib/utils'
import { Icon } from '@/shared/ui/icon'

import { basename } from './paths'
import type { OpenDoc } from './use-explorer'

export interface ExplorerTabsProps {
  tabs: string[]
  active: string | null
  dirtyPaths: string[]
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

/** 打开的标签页：文件名在前、完整路径在 title，未保存的标签带圆点。 */
export function ExplorerTabs({ tabs, active, dirtyPaths, onSelect, onClose }: ExplorerTabsProps) {
  return (
    <div className="scroll-area flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist" aria-label="打开的文件">
      {tabs.map(path => {
        const selected = active === path
        const dirtyText = dirtyPaths.includes(path)
        return (
          <div
            key={path}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-testid="explorer-tab"
            data-path={path}
            title={path}
            className={cn(
              'group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-line px-3 py-1.5 text-[12px] transition-colors',
              selected ? 'bg-surface text-txt' : 'text-txt3 hover:bg-elevated',
            )}
            onClick={() => onSelect(path)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelect(path) }}
          >
            <Icon name="doc" size={12} />
            <span className="max-w-[160px] truncate font-mono">{basename(path)}</span>
            {dirtyText && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="未保存" title="未保存" />}
            <button
              type="button"
              aria-label={`关闭 ${basename(path)}`}
              title="关闭"
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded text-txt3 hover:bg-overlay hover:text-txt',
                selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
              onClick={event => { event.stopPropagation(); onClose(path) }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** 编辑器状态栏：语言、行数、字符数与完整路径。 */
export function EditorStatusBar({ doc, stats }: {
  doc: OpenDoc
  stats: { language: string; lines: number; characters: number; size: string } | null
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-line/60 px-3 py-1 text-[10.5px] text-txt3">
      <span className="uppercase">{stats?.language ?? '文件'}</span>
      {stats && <span>{stats.lines} 行</span>}
      {stats && <span>{stats.characters} 字符</span>}
      <span className="rounded-md border border-line px-1.5 text-[10px] text-txt2">{stats?.size ?? '—'}</span>
      <span className="ml-auto truncate font-mono" title={doc.path}>{doc.path}</span>
    </div>
  )
}
