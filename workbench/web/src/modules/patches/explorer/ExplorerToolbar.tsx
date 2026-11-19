import { cn } from '@/shared/lib/utils'
import { Icon } from '@/shared/ui/icon'

const buttonClass = 'inline-flex shrink-0 items-center justify-center rounded text-txt3 transition-colors hover:bg-elevated hover:text-accent-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

export interface ExplorerToolbarProps {
  compact: boolean
  collapsed: boolean
  onNewFile: () => void
  onNewFolder: () => void
  onUpload: () => void
  onImport: () => void
  onToggleCollapse: () => void
}

/** 紧凑工具栏：新建、上传、导入与折叠；窄屏下按 44px 触控目标放大。 */
export function ExplorerToolbar(props: ExplorerToolbarProps) {
  const { compact, collapsed, onNewFile, onNewFolder, onUpload, onImport, onToggleCollapse } = props
  const sizeClass = compact ? 'min-h-11 min-w-11' : 'h-6 w-6'

  if (collapsed && !compact) {
    return (
      <div className="flex shrink-0 flex-col items-center border-r border-line py-1.5">
        <button
          type="button"
          className={cn(buttonClass, sizeClass)}
          title="展开文件面板"
          aria-label="展开文件面板"
          onClick={onToggleCollapse}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className={cn('flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5', compact ? 'min-h-11' : 'min-h-8')}>
      <span className={cn('flex-1 truncate px-1 text-txt3', compact ? 'text-[10.5px] font-semibold uppercase tracking-wider' : 'text-[11px] font-medium')}>
        文件
      </span>
      <button type="button" className={cn(buttonClass, sizeClass)} title="新建文件" aria-label="新建文件" onClick={onNewFile}>
        <Icon name="doc" size={14} />
      </button>
      <button type="button" className={cn(buttonClass, sizeClass)} title="新建文件夹" aria-label="新建文件夹" onClick={onNewFolder}>
        <Icon name="folder" size={14} />
      </button>
      <button type="button" className={cn(buttonClass, sizeClass)} title="上传文件" aria-label="上传文件" onClick={onUpload}>
        <Icon name="download" size={14} />
      </button>
      <button type="button" className={cn(buttonClass, sizeClass)} title="导入目录" aria-label="导入目录" onClick={onImport}>
        <Icon name="layers" size={14} />
      </button>
      {!compact && (
        <button
          type="button"
          className={cn(buttonClass, sizeClass)}
          title="折叠文件面板"
          aria-label="折叠文件面板"
          onClick={onToggleCollapse}
        >
          <Icon name="chevron-left" size={14} />
        </button>
      )}
    </div>
  )
}
