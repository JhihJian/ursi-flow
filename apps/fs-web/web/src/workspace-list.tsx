import { useState } from 'react'
import { ChevronsRight, Folder, Plus } from 'lucide-react'
import type { WorkspaceInfo } from './api.ts'
import { useTreeStore } from './tree-store.ts'
import { ContextMenu, type MenuItem, type MenuState } from './context-menu.tsx'
import { copyText } from './lib/clipboard.ts'

type OpenMenu = (x: number, y: number, items: MenuItem[], heading?: string) => void

/** 行内输入：回车提交、Esc 取消、失焦提交（与树内重命名同语义）。 */
function InlineInput({
  initial,
  placeholder,
  multiline,
  onDone,
}: {
  initial: string
  placeholder: string
  multiline?: boolean
  onDone: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  const commit = () => onDone(value)
  if (multiline) {
    return (
      <textarea
        className="wsx-wslist-input wsx-wslist-input--area"
        value={value}
        placeholder={placeholder}
        rows={2}
        autoFocus
        onFocus={(event) => event.target.select()}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') onDone(initial)
        }}
      />
    )
  }
  return (
    <input
      className="wsx-wslist-input"
      value={value}
      placeholder={placeholder}
      autoFocus
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') onDone(initial)
      }}
    />
  )
}

/** 悬停 tooltip：名称 · 路径 · 说明，折叠态书脊共用。 */
function itemSummary(workspace: WorkspaceInfo): string {
  return [workspace.label, workspace.root, workspace.description].filter(Boolean).join(' · ')
}

/** 行内轻提示：复制成功/失败后短暂显示。 */
function useFlash(): [string, (message: string) => void] {
  const [flash, setFlash] = useState('')
  const show = (message: string): void => {
    setFlash(message)
    window.setTimeout(() => setFlash(''), 1200)
  }
  return [flash, show]
}

interface WorkspaceItemProps {
  workspace: WorkspaceInfo
  active: boolean
  openMenu: OpenMenu
  onRemove: (workspaceId: string, wasActive: boolean) => void
}

function WorkspaceItem({ workspace, active, openMenu, onRemove }: WorkspaceItemProps) {
  const selectWorkspace = useTreeStore((state) => state.selectWorkspace)
  const renameWorkspace = useTreeStore((state) => state.renameWorkspace)
  const removeWorkspace = useTreeStore((state) => state.removeWorkspace)
  const [editing, setEditing] = useState<'label' | 'description' | null>(null)
  const [flash, showFlash] = useFlash()

  const copyRoot = (event: React.MouseEvent): void => {
    // 仅选中态提供复制；未选中时不拦截事件，让冒泡走条目的 onClick 切换选中。
    if (!active) return
    event.stopPropagation()
    void copyText(workspace.root)
      .then(() => showFlash('已复制'))
      .catch(() => showFlash('复制失败'))
  }

  const menuItems: MenuItem[] = [
    { label: '重命名', onSelect: () => setEditing('label') },
    { label: '编辑说明', onSelect: () => setEditing('description') },
    {
      label: '移除',
      danger: true,
      onSelect: () => {
        // 菜单已关闭，再在条目位置弹内联确认（契约禁原生 confirm）。
        const rect = document
          .querySelector(`[data-wsx-ws-id="${workspace.id}"]`)
          ?.getBoundingClientRect()
        const confirmItems: MenuItem[] = [
          {
            label: '移除',
            danger: true,
            onSelect: () => {
              void removeWorkspace(workspace.id).then((wasActive) => onRemove(workspace.id, wasActive))
            },
          },
          { label: '取消', onSelect: () => {} },
        ]
        openMenu(rect?.left ?? 0, (rect?.bottom ?? 0) + 4, confirmItems, `移除「${workspace.label}」？仅从列表移除，不动文件。`)
      },
    },
  ]

  if (editing) {
    const isLabel = editing === 'label'
    return (
      <li className="wsx-wslist-item wsx-wslist-item--editing" data-wsx-ws-id={workspace.id}>
        <InlineInput
          initial={isLabel ? workspace.label : workspace.description ?? ''}
          placeholder={isLabel ? '显示名称' : '一句话说明（可留空清除）'}
          multiline={!isLabel}
          onDone={(value) => {
            setEditing(null)
            const text = value.trim()
            if (isLabel) {
              if (text && text !== workspace.label) void renameWorkspace(workspace.id, { label: text })
            } else if (text !== (workspace.description ?? '')) {
              void renameWorkspace(workspace.id, { description: text })
            }
          }}
        />
      </li>
    )
  }

  return (
    <li
      data-wsx-ws-id={workspace.id}
      className={'wsx-wslist-item' + (active ? ' wsx-wslist-item--active' : '') + (workspace.ready ? '' : ' wsx-wslist-item--broken')}
      title={itemSummary(workspace) + (workspace.error ? `（${workspace.error}）` : '')}
      onClick={() => selectWorkspace(workspace.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY, menuItems)
      }}
    >
      <span className="wsx-wslist-rowhead">
        <Folder className="wsx-wslist-icon" size={12} aria-hidden="true" />
        <span className="wsx-wslist-name">{workspace.label}</span>
        <span className="wsx-wslist-rowtail">
          {flash ? <span className="wsx-wslist-flash">{flash}</span> : null}
          {!workspace.ready ? <span className="wsx-wslist-broken" title={workspace.error}>!</span> : null}
        </span>
      </span>
      <span
        className={'wsx-wslist-path' + (active ? ' wsx-wslist-path--copyable' : '')}
        title={active ? `${workspace.root}（点击复制）` : workspace.root}
        onClick={copyRoot}
      >
        {workspace.root}
      </span>
    </li>
  )
}

interface WorkspaceListProps {
  onRemove: (workspaceId: string, wasActive: boolean) => void
  /** 折叠 rail 由宿主（standalone 可拖宽布局）控制；缺省不渲染。 */
  collapsed?: boolean
  onExpand?: () => void
}

/** 一级侧栏：记录的目录列表。头部为内联添加表单，行右键重命名/说明/移除。 */
export function WorkspaceList({ onRemove, collapsed, onExpand }: WorkspaceListProps) {
  const workspaces = useTreeStore((state) => state.workspaces)
  const activeWorkspaceId = useTreeStore((state) => state.activeWorkspaceId)
  const addWorkspace = useTreeStore((state) => state.addWorkspace)
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const openMenu: OpenMenu = (x, y, items, heading) => setMenu({ x, y, items, heading })
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId)

  if (collapsed) {
    // 折叠 rail：书脊式竖排选中目录名（todo-web 同款），点击展开。
    return (
      <div className="wsx-wslist-collapsed">
        <button type="button" className="wsx-rail-toggle" title="展开目录列表" aria-label="展开目录列表" onClick={onExpand}>
          <ChevronsRight size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="wsx-wslist-spine"
          title={active ? itemSummary(active) : '未选择目录'}
          aria-label={active ? `${itemSummary(active)}。展开目录列表` : '展开目录列表'}
          onClick={onExpand}
        >
          {active?.label ?? '未选择'}
        </button>
      </div>
    )
  }

  return (
    <aside
      className="wsx-wslist"
      onContextMenu={(event) => {
        // 条目自己处理右键；空白处打开添加表单。
        event.preventDefault()
        setAdding(true)
      }}
    >
      <div className="wsx-wslist-head">
        <span className="wsx-wslist-title">目录</span>
        <button
          type="button"
          className="wsx-wslist-add"
          title="添加目录"
          aria-label="添加目录"
          onClick={() => setAdding(true)}
        >
          <Plus size={12} aria-hidden="true" />
        </button>
      </div>
      {adding ? (
        <div className="wsx-wslist-adding">
          <InlineInput
            initial=""
            placeholder="输入绝对路径，如 /data/dev"
            onDone={(value) => {
              setAdding(false)
              const root = value.trim()
              if (root) void addWorkspace(root)
            }}
          />
        </div>
      ) : null}
      <ul className="wsx-wslist-items">
        {workspaces.map((workspace) => (
          <WorkspaceItem
            key={workspace.id}
            workspace={workspace}
            active={workspace.id === activeWorkspaceId}
            openMenu={openMenu}
            onRemove={onRemove}
          />
        ))}
      </ul>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </aside>
  )
}
