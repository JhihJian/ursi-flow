import type { MouseEvent as ReactMouseEvent } from 'react'
import { SidebarGroup, SidebarRow } from '@ursi/sidebar'
import type { SessionRow, SessionRuntime } from '../api'
import { GROUP_VISIBLE, SHOW_MORE_STEP, type useGroupFold } from '../hooks/useGroupFold'
import { formatAge, sessionMeta, sessionTitle, type SessionGroup } from '../lib/format'

interface SessionGroupListProps {
  groups: readonly SessionGroup[]
  /** 特别关注的项目键，组名旁据此显示标记点。 */
  pinnedKeys: ReadonlySet<string>
  /** 会话页指向的会话 id。 */
  activeId: string | null
  /** 当前目录（新对话会落在它下面）：对应的组头高亮。 */
  activeGroupKey: string | null
  /** 这条会话的存活状态；心跳插件未开启时传 () => null。 */
  liveForRow: (row: SessionRow) => SessionRuntime | null
  fold: ReturnType<typeof useGroupFold>
  onSelect: (row: SessionRow) => void
  /** 点组头（翻转之外）附带的事：目录成为当前目录。 */
  onPickGroup: (group: SessionGroup) => void
  onGroupMenu: (event: ReactMouseEvent, group: SessionGroup, pinned: boolean) => void
  onSessionMenu: (event: ReactMouseEvent, row: SessionRow) => void
}

/**
 * 一段项目分组：组头是目录，点行翻转并把它设为当前目录，带右键菜单，
 * 组内是会话行与「显示更多 / 收起」。纯受控组件，不持有状态。
 */
export function SessionGroupList({
  groups,
  pinnedKeys,
  activeId,
  activeGroupKey,
  liveForRow,
  fold,
  onSelect,
  onPickGroup,
  onGroupMenu,
  onSessionMenu,
}: SessionGroupListProps) {
  return (
    <>
      {groups.map((group) => {
        const isFolded = fold.isFolded(group.key)
        const shown = Math.min(group.sessions.length, fold.visibleCount(group.key))
        const hidden = group.sessions.length - shown
        return (
          <SidebarGroup
            key={group.key}
            className="session-group"
            open={!isFolded}
            onToggle={() => fold.toggleGroup(group.key)}
            onClick={() => onPickGroup(group)}
            active={activeGroupKey === group.key}
            title={`${group.key}\n点它作为新对话的目录`}
            onContextMenu={(event) => onGroupMenu(event, group, pinnedKeys.has(group.key))}
            label={group.label}
            meta={group.sessions.length}
            trailing={pinnedKeys.has(group.key) ? <span className="session-group-pin">●</span> : null}
          >
            {group.sessions.slice(0, shown).map((row) => (
              <SessionRowItem
                key={row.id}
                row={row}
                active={row.id === activeId}
                live={liveForRow(row)}
                onSelect={() => onSelect(row)}
                onMenu={onSessionMenu}
              />
            ))}
            {hidden > 0 ? (
              <button type="button" className="session-more" onClick={() => fold.showMore(group.key)}>
                显示更多 {Math.min(hidden, SHOW_MORE_STEP)}
              </button>
            ) : null}
            {shown > GROUP_VISIBLE ? (
              <button type="button" className="session-more" onClick={() => fold.collapseMore(group.key)}>
                收起
              </button>
            ) : null}
          </SidebarGroup>
        )
      })}
    </>
  )
}

interface SessionRowItemProps {
  row: SessionRow
  active: boolean
  live: SessionRuntime | null
  onSelect: () => void
  onMenu: (event: ReactMouseEvent, row: SessionRow) => void
}

/**
 * 一行会话：标题一行，下面是时间（运行中时换成模型名）与次要信息。
 * 存活状态只在心跳插件开启时才会传进来，未开启时不渲染状态点。
 */
function SessionRowItem({ row, active, live, onSelect, onMenu }: SessionRowItemProps) {
  const running = live?.status === 'running'
  return (
    <SidebarRow
      className={live ? 'session-item is-live' : 'session-item'}
      active={active}
      title={`${sessionTitle(row)}\n${row.cwd || row.path}`}
      onClick={onSelect}
      onContextMenu={(event) => onMenu(event, row)}
      label={
        <>
          {live ? (
            <span
              className={`session-live-dot is-${live.status}`}
              aria-label={running ? '运行中' : '空闲'}
            />
          ) : null}
          {sessionTitle(row)}
        </>
      }
      meta={
        <>
          <span>{live && row.model ? row.model : formatAge(row.modified)}</span>
          <span>{sessionMeta(row)}</span>
        </>
      }
    />
  )
}
