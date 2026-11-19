import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/shared/lib/utils'
import { Icon } from '@/shared/ui/icon'

import type { CtxAction, CtxTarget } from './use-explorer'

interface MenuItem {
  action: CtxAction
  label: string
  icon: string
  disabled?: boolean
  danger?: boolean
  hint?: string
}

export interface ExplorerContextMenuProps {
  x: number
  y: number
  target: CtxTarget
  onAction: (action: CtxAction) => void
  onClose: () => void
}

/**
 * 文件树右键菜单：文件可下载与复制路径，目录可新建与导入，空白处只保留新建。
 * 菜单会在视口内翻转，避免贴边被裁掉。
 */
export function ExplorerContextMenu({ x, y, target, onAction, onClose }: ExplorerContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const margin = 8
    const rect = menu.getBoundingClientRect()
    const left = Math.min(x, window.innerWidth - rect.width - margin)
    const top = Math.min(y, window.innerHeight - rect.height - margin)
    setPosition({ left: Math.max(margin, left), top: Math.max(margin, top) })
  }, [x, y])

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const blank = Boolean(target.blank)
  const items: Array<MenuItem | null> = [
    { action: 'newFile', label: '新建文件', icon: 'doc' },
    { action: 'newFolder', label: '新建文件夹', icon: 'folder' },
    { action: 'uploadFile', label: '上传文件', icon: 'download' },
    { action: 'importDir', label: '导入目录', icon: 'layers' },
    null,
    { action: 'rename', label: '重命名', icon: 'edit', disabled: blank, hint: 'F2' },
    { action: 'copyPath', label: '复制路径', icon: 'copy', disabled: target.dir || blank },
    ...(target.dir || blank ? [] : [{ action: 'download' as CtxAction, label: '下载', icon: 'download' as const }]),
    null,
    { action: 'delete', label: '删除', icon: 'trash', disabled: blank, danger: true },
  ]

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-testid="explorer-context-menu"
      aria-label="文件操作"
      className="fixed z-[70] min-w-[196px] rounded-lg border border-line bg-surface py-1 shadow-card"
      style={{ left: position.left, top: position.top }}
      onContextMenu={event => event.preventDefault()}
      onMouseDown={event => event.stopPropagation()}
    >
      {items.map((item, position_) => item ? (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          data-action={item.action}
          disabled={item.disabled}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors',
            item.danger ? 'text-err hover:bg-err/10' : 'text-txt2 hover:bg-elevated hover:text-txt',
            item.disabled && 'pointer-events-none opacity-40',
          )}
          onClick={() => onAction(item.action)}
        >
          <Icon name={item.icon} size={14} className="text-txt3" />
          <span className="flex-1">{item.label}</span>
          {item.hint && <span className="text-[10px] text-txt3">{item.hint}</span>}
        </button>
      ) : (
        <div key={`separator-${position_}`} className="my-1 h-px bg-line" role="separator" />
      ))}
    </div>,
    document.body,
  )
}
