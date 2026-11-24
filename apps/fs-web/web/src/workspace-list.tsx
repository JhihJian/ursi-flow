import { useState } from 'react'
import type { WorkspaceInfo } from './api.ts'
import { useTreeStore } from './tree-store.ts'
import { ContextMenu, type MenuItem, type MenuState } from './context-menu.tsx'

type OpenMenu = (x: number, y: number, items: MenuItem[], heading?: string) => void

/** 行内输入：回车提交、Esc 取消、失焦提交（与树内重命名同语义）。 */
function InlineInput({
  initial,
  placeholder,
  onDone,
}: {
  initial: string
  placeholder: string
  onDone: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <input
      className="wsx-wslist-input"
      value={value}
      placeholder={placeholder}
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

interface WorkspaceItemProps {
  workspace: WorkspaceInfo
  active: boolean
  openMenu: OpenMenu
  /** 移除成功后的清理回调（关闭编辑器、清外壳选中），由持有上下文的父层提供。 */
  onRemove: (workspaceId: string, wasActive: boolean) => void
}

function WorkspaceItem({ workspace, active, openMenu, onRemove }: WorkspaceItemProps) {
  const selectWorkspace = useTreeStore((state) => state.selectWorkspace)
  const renameWorkspace = useTreeStore((state) => state.renameWorkspace)
  const removeWorkspace = useTreeStore((state) => state.removeWorkspace)
  const [renaming, setRenaming] = useState(false)

  const menuItems: MenuItem[] = [
    { label: '重命名', onSelect: () => setRenaming(true) },
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

  if (renaming) {
    return (
      <li className="wsx-wslist-item wsx-wslist-item--editing" data-wsx-ws-id={workspace.id}>
        <InlineInput
          initial={workspace.label}
          placeholder="显示名称"
          onDone={(value) => {
            setRenaming(false)
            const name = value.trim()
            if (name && name !== workspace.label) void renameWorkspace(workspace.id, name)
          }}
        />
      </li>
    )
  }

  return (
    <li
      data-wsx-ws-id={workspace.id}
      className={'wsx-wslist-item' + (active ? ' wsx-wslist-item--active' : '') + (workspace.ready ? '' : ' wsx-wslist-item--broken')}
      title={workspace.error ? `${workspace.root}（${workspace.error}）` : workspace.root}
      onClick={() => selectWorkspace(workspace.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY, menuItems)
      }}
    >
      <span className="wsx-wslist-name">{workspace.label}</span>
      {!workspace.ready ? <span className="wsx-wslist-broken" title={workspace.error}>!</span> : null}
    </li>
  )
}

/** 一级侧栏：记录的目录列表。头部为内联添加表单，行右键重命名/移除。 */
export function WorkspaceList({ onRemove }: { onRemove: (workspaceId: string, wasActive: boolean) => void }) {
  const workspaces = useTreeStore((state) => state.workspaces)
  const activeWorkspaceId = useTreeStore((state) => state.activeWorkspaceId)
  const addWorkspace = useTreeStore((state) => state.addWorkspace)
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const openMenu: OpenMenu = (x, y, items, heading) => setMenu({ x, y, items, heading })

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
          +
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
