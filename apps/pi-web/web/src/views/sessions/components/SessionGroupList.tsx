import type { MouseEvent as ReactMouseEvent } from 'react'
import type { SessionRow } from '../api'
import { GROUP_VISIBLE, SHOW_MORE_STEP, type useGroupFold } from '../hooks/useGroupFold'
import { formatAge, sessionMeta, sessionTitle, type SessionGroup } from '../lib/format'
import type { LiveSessionInfo } from '../live'

interface SessionGroupListProps {
  groups: readonly SessionGroup[]
  /** 特别关注的项目键，组名旁据此显示标记点。 */
  pinnedKeys: ReadonlySet<string>
  selectedId: string | null
  /** 这条会话的存活状态；心跳插件未开启时传 () => null。 */
  liveForRow: (row: SessionRow) => LiveSessionInfo | null
  fold: ReturnType<typeof useGroupFold>
  onSelect: (row: SessionRow) => void
  onGroupMenu: (event: ReactMouseEvent, group: SessionGroup) => void
  onSessionMenu: (event: ReactMouseEvent, row: SessionRow) => void
}

/**
 * 一段项目分组：组头可折叠、带右键菜单，组内是会话行与「显示更多 / 收起」。
 * 纯受控组件，不持有状态；折叠与显示更多由 fold 给出。
 */
export function SessionGroupList({
  groups,
  pinnedKeys,
  selectedId,
  liveForRow,
  fold,
  onSelect,
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
          <section className="session-group" key={group.key}>
            <button
              type="button"
              className="session-group-head"
              title={group.key}
              aria-expanded={!isFolded}
              data-pinned={pinnedKeys.has(group.key)}
              onClick={() => fold.toggleGroup(group.key)}
              onContextMenu={(event) => onGroupMenu(event, group)}
            >
              <span className="session-group-caret">{isFolded ? '▸' : '▾'}</span>
              <span className="session-group-name">{group.name}</span>
              {pinnedKeys.has(group.key) ? (
                <span className="session-group-pin" aria-label="特别关注">
                  ●
                </span>
              ) : null}
              <span className="session-group-count">{group.sessions.length}</span>
            </button>

            {isFolded
              ? null
              : group.sessions.slice(0, shown).map((row) => (
                  <SessionRowItem
                    key={row.id}
                    row={row}
                    active={row.id === selectedId}
                    live={liveForRow(row)}
                    onSelect={() => onSelect(row)}
                    onMenu={onSessionMenu}
                  />
                ))}
            {!isFolded && hidden > 0 ? (
              <button type="button" className="session-more" onClick={() => fold.showMore(group.key)}>
                显示更多 {Math.min(hidden, SHOW_MORE_STEP)}
              </button>
            ) : null}
            {!isFolded && shown > GROUP_VISIBLE ? (
              <button type="button" className="session-more" onClick={() => fold.collapseMore(group.key)}>
                收起
              </button>
            ) : null}
          </section>
        )
      })}
    </>
  )
}

interface SessionRowItemProps {
  row: SessionRow
  active: boolean
  live: LiveSessionInfo | null
  onSelect: () => void
  onMenu: (event: ReactMouseEvent, row: SessionRow) => void
}

/**
 * 一行会话：标题一行，下面是时间（运行中时换成模型名）与次要信息。
 * 存活状态只在心跳插件开启时才会传进来，未开启时不渲染状态点。
 */
function SessionRowItem({ row, active, live, onSelect, onMenu }: SessionRowItemProps) {
  const running = live?.status === 'running'
  const classes = ['session-item']
  if (active) classes.push('active')
  if (live) classes.push('is-live')
  return (
    <button
      type="button"
      className={classes.join(' ')}
      title={`${sessionTitle(row)}\n${row.cwd || row.path}`}
      onClick={onSelect}
      onContextMenu={(event) => onMenu(event, row)}
    >
      <span className="name">
        {live ? (
          <span
            className={`session-live-dot is-${live.status}`}
            aria-label={running ? '运行中' : '空闲'}
          />
        ) : null}
        {sessionTitle(row)}
      </span>
      <span className="meta">
        <span>{live ? live.model ?? formatAge(row.modified) : formatAge(row.modified)}</span>
        <span>{sessionMeta(row)}</span>
      </span>
    </button>
  )
}
