import type { MouseEvent as ReactMouseEvent } from 'react'
import type { SessionRow } from '../api'
import { GROUP_VISIBLE, SHOW_MORE_STEP, type useGroupFold } from '../hooks/useGroupFold'
import { formatAge, sessionMeta, sessionTitle, type SessionGroup } from '../lib/format'
import type { LiveSessionInfo } from '../live'

interface SessionGroupListProps {
  groups: readonly SessionGroup[]
  /** 特别关注的项目键，组名旁据此显示标记点。 */
  pinnedKeys: ReadonlySet<string>
  /** 会话页指向的会话文件。 */
  activeFile: string | null
  /** 当前目录（新对话会落在它下面）：对应的组头高亮。 */
  activeGroupKey: string | null
  /** 这条会话的存活状态；心跳插件未开启时传 () => null。 */
  liveForRow: (row: SessionRow) => LiveSessionInfo | null
  fold: ReturnType<typeof useGroupFold>
  onSelect: (row: SessionRow) => void
  /** 点组头：目录成为当前目录，不折叠；折叠由左侧的箭头负责。 */
  onPickGroup: (group: SessionGroup) => void
  onGroupMenu: (event: ReactMouseEvent, group: SessionGroup) => void
  onSessionMenu: (event: ReactMouseEvent, row: SessionRow) => void
}

/**
 * 一段项目分组：组头是目录（点它成为当前目录，箭头折叠），带右键菜单，
 * 组内是会话行与「显示更多 / 收起」。纯受控组件，不持有状态。
 */
export function SessionGroupList({
  groups,
  pinnedKeys,
  activeFile,
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
          <section className="session-group" key={group.key}>
            <div
              className={`session-group-head${activeGroupKey === group.key ? ' is-cwd' : ''}`}
              data-pinned={pinnedKeys.has(group.key)}
              onContextMenu={(event) => onGroupMenu(event, group)}
            >
              <button
                type="button"
                className="session-group-caret"
                title={isFolded ? '展开' : '折叠'}
                aria-expanded={!isFolded}
                onClick={() => fold.toggleGroup(group.key)}
              >
                {isFolded ? '▸' : '▾'}
              </button>
              <button
                type="button"
                className="session-group-name"
                title={`${group.key}\n点它作为新对话的目录`}
                aria-pressed={activeGroupKey === group.key}
                onClick={() => onPickGroup(group)}
              >
                {group.label}
              </button>
              {pinnedKeys.has(group.key) ? (
                <span className="session-group-pin" aria-label="特别关注">
                  ●
                </span>
              ) : null}
              <span className="session-group-count">{group.sessions.length}</span>
            </div>

            {isFolded
              ? null
              : group.sessions.slice(0, shown).map((row) => (
                  <SessionRowItem
                    key={row.id}
                    row={row}
                    active={row.path === activeFile}
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
