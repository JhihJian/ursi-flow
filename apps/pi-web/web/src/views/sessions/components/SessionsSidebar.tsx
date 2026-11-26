import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import type { SessionRow } from '../api'
import { primaryLive, type LiveSessionInfo } from '../live'
import type { SessionGroup } from '../lib/format'
import {
  dailyBuckets,
  dayKey,
  defaultFoldedGroups,
  formatAge,
  groupSessions,
  sessionMeta,
  sessionTitle,
  shortRoot,
  splitPinnedGroups,
  todayKey,
} from '../lib/format'
import { useSessionsController } from '../sessions-context'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { RefreshIcon, SearchIcon } from './Icons'

/** 每个项目组默认显示这么多条会话，「显示更多」一次再放 20 条。 */
const GROUP_VISIBLE = 8
const SHOW_MORE_STEP = 20
/** 列表还没到时用的空数组：保持引用稳定，免得每次渲染都重算条形。 */
const NO_ROWS: SessionRow[] = []

/**
 * 外壳里的会话侧边栏：外框交给平台的 SidebarFrame（上下折叠），里面是
 * 根目录、按日筛选条形、搜索与按项目分组的会话列表。
 * 结构与 todo-web 的项目栏一致：衬线小标题、等宽次信息、选中靠左侧竖线。
 */
export function SessionsSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  const {
    root,
    configError,
    listing,
    loading,
    error,
    query,
    setQuery,
    selected,
    select,
    pinnedProjects,
    togglePin,
    deleteSession,
    reload,
    notice,
    clearNotice,
    setPicking,
    liveByPath,
    liveError,
    focusDay,
    clearFocusDay,
  } = useSessionsController()
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [more, setMore] = useState<Record<string, number>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  // 搜索默认收起成图标，点开才显示输入框；收起时清空，避免看不见的过滤条件。
  const [searchOpen, setSearchOpen] = useState(false)
  // 默认只看今天；换根目录时回到今天，避免沿用别处目录的日期选择。
  const [selectedDays, setSelectedDays] = useState<ReadonlySet<string>>(() => new Set([todayKey()]))
  useEffect(() => {
    setSelectedDays(new Set([todayKey()]))
  }, [root])
  // 跨模块跳转过来的会话可能不在今天：把它的日期并进筛选，否则选中了却看不见。
  useEffect(() => {
    if (focusDay === null) return
    setSelectedDays((current) => new Set([...current, dayKey(focusDay)]))
    clearFocusDay()
  }, [focusDay, clearFocusDay])

  // 确认菜单要落在原菜单位置上：菜单关闭后 state 已清空，位置另存一份。
  const menuAt = useRef({ x: 0, y: 0 })
  // 浮层挂在侧边栏容器内，避免用全局 position: fixed 在多区域布局里坐标错位。
  const containerRef = useRef<HTMLDivElement>(null)

  // 条形按整份列表统计，不跟着搜索与筛选变，否则选一天后其它天就消失了。
  const allRows = listing?.sessions ?? NO_ROWS
  const buckets = useMemo(() => dailyBuckets(allRows), [allRows])
  // 筛选中某一天时把日期写进脚注，比「筛选 1 天」更有用。
  const daySummary = useMemo(() => {
    if (selectedDays.size === 0) return ''
    if (selectedDays.size === 1) return `筛选 ${[...selectedDays][0].slice(5)}`
    return `筛选 ${selectedDays.size} 天`
  }, [selectedDays])
  /** 运行态：只接注入来源，按会话文件路径与磁盘行对齐。 */
  const liveRows = useMemo(() => {
    const rowsByPath = new Map(allRows.map((row) => [row.path, row] as const))
    return [...liveByPath.entries()]
      .map(([path, list]) => ({ session: primaryLive(list), row: rowsByPath.get(path) ?? null, path }))
      .filter((item): item is { session: LiveSessionInfo; row: SessionRow | null; path: string } =>
        Boolean(item.session),
      )
      .sort((a, b) => {
        if (a.session.status !== b.session.status) return a.session.status === 'running' ? -1 : 1
        return b.session.updatedAt - a.session.updatedAt
      })
  }, [liveByPath, allRows])

  const groups = groupSessions(allRows, query, selectedDays)
  const { pinned, rest } = splitPinnedGroups(groups, pinnedProjects)
  const pinnedKeySet = useMemo(() => new Set(pinnedProjects), [pinnedProjects])
  // 用户点过的组按用户选择，没点过的按默认规则（第一组与选中会话所在的组展开）。
  const foldedByDefault = useMemo(
    () => defaultFoldedGroups(groups, selected?.id ?? null),
    [groups, selected],
  )
  const isFoldedGroup = (key: string) => folded[key] ?? foldedByDefault.has(key)

  const toggleGroup = (key: string) => {
    const next = !isFoldedGroup(key)
    setFolded((current) => ({ ...current, [key]: next }))
  }

  const showMore = (key: string) => {
    setMore((current) => ({ ...current, [key]: (current[key] ?? 0) + SHOW_MORE_STEP }))
  }

  const openMenu = (event: ReactMouseEvent, items: MenuItem[], heading?: string) => {
    event.preventDefault()
    event.stopPropagation()
    menuAt.current = { x: event.clientX, y: event.clientY }
    setMenu({ x: event.clientX, y: event.clientY, items, heading })
  }

  /** 项目组右键：关注 / 取消关注。 */
  const projectMenu = (event: ReactMouseEvent, group: SessionGroup) => {
    const isPinned = pinnedKeySet.has(group.key)
    openMenu(
      event,
      [
        {
          label: isPinned ? '取消特别关注' : '设为特别关注',
          onSelect: () => togglePin(group.key, !isPinned),
        },
      ],
      group.name,
    )
  }

  /** 会话行右键：打开、复制标识、删除。 */
  const sessionMenu = (event: ReactMouseEvent, row: SessionRow) => {
    openMenu(
      event,
      [
        { label: '打开', onSelect: () => select(row) },
        { label: '复制会话 ID', onSelect: () => void navigator.clipboard?.writeText(row.id) },
        { label: '复制文件路径', onSelect: () => void navigator.clipboard?.writeText(row.path) },
        { label: '删除会话…', danger: true, onSelect: () => confirmDelete(row) },
      ],
      sessionTitle(row),
    )
  }

  /**
   * 删除的二次确认。菜单已经关掉，用同一位置再弹一个菜单，
   * 与看板的删除项目一致：确认项本身也带删除语义的颜色。
   */
  const confirmDelete = (row: SessionRow) => {
    setMenu({
      x: menuAt.current.x,
      y: menuAt.current.y,
      heading: `删除「${sessionTitle(row)}」？`,
      items: [
        { label: '删除会话文件', danger: true, onSelect: () => deleteSession(row) },
        { label: '取消', onSelect: () => undefined },
      ],
    })
  }

  const liveForRow = (row: SessionRow) => primaryLive(liveByPath.get(row.path))

  const renderGroup = (group: SessionGroup) => {
    const isFolded = isFoldedGroup(group.key)
    const shown = Math.min(group.sessions.length, GROUP_VISIBLE + (more[group.key] ?? 0))
    const hidden = group.sessions.length - shown
    return (
      <section className="session-group" key={group.key}>
        <button
          type="button"
          className="session-group-head"
          title={group.key}
          aria-expanded={!isFolded}
          onClick={() => toggleGroup(group.key)}
          onContextMenu={(event) => projectMenu(event, group)}
        >
          <span className="session-group-caret">{isFolded ? '▸' : '▾'}</span>
          <span className="session-group-name">{group.name}</span>
          {pinnedKeySet.has(group.key) ? (
            <span className="session-group-pin" aria-label="特别关注">
              ●
            </span>
          ) : null}
          <span className="session-group-count">{group.sessions.length}</span>
        </button>

        {isFolded ? null : (
          <ul className="session-items">
            {group.sessions.slice(0, shown).map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={`${row.id === selected?.id ? 'session-item active' : 'session-item'}${liveForRow(row) ? ' is-live' : ''}`}
                  title={`${sessionTitle(row)}\n${row.cwd || row.path}`}
                  onClick={() => select(row)}
                  onContextMenu={(event) => sessionMenu(event, row)}
                >
                  <span className="name">
                    {liveForRow(row) ? (
                      <span
                        className={`session-live-dot is-${liveForRow(row)?.status}`}
                        aria-label={liveForRow(row)?.status === 'running' ? '运行中' : '空闲'}
                      />
                    ) : null}
                    {sessionTitle(row)}
                  </span>
                  <span className="meta">
                    <span>{liveForRow(row) ? liveForRow(row)?.model ?? formatAge(row.modified) : formatAge(row.modified)}</span>
                    <span>{sessionMeta(row)}</span>
                  </span>
                </button>
              </li>
            ))}
            {hidden > 0 ? (
              <li>
                <button type="button" className="session-more" onClick={() => showMore(group.key)}>
                  显示更多 {Math.min(hidden, SHOW_MORE_STEP)}
                </button>
              </li>
            ) : null}
            {shown > GROUP_VISIBLE ? (
              <li>
                <button
                  type="button"
                  className="session-more"
                  onClick={() => setMore((current) => ({ ...current, [group.key]: 0 }))}
                >
                  收起
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </section>
    )
  }

  const railItems = selected
    ? [
        { label: '会话', value: sessionTitle(selected) },
        { label: '项目', value: selected.projectName },
      ]
    : [
        { label: '会话', value: listing ? String(listing.sessions.length) : '—' },
        { label: '项目', value: String(groups.length) },
      ]

  return (
    <div className="pisess pisess-sidebar-host" ref={containerRef}>
      <SidebarFrame
        title="Sessions"
        collapsed={collapsed}
        collapse={collapse}
        expand={expand}
        items={railItems}
        actions={
          <button
            type="button"
            className={searchOpen ? 'rail-toggle active' : 'rail-toggle'}
            title={searchOpen ? '收起搜索' : '搜索会话'}
            aria-label={searchOpen ? '收起搜索' : '搜索会话'}
            aria-expanded={searchOpen}
            onClick={() => {
              const next = !searchOpen
              setSearchOpen(next)
              // 收起就清空：看不见的过滤条件比失去它更糟。
              if (!next && query) setQuery('')
            }}
          >
            <SearchIcon />
          </button>
        }
      >
        <div className="pisess-body">
          {configError ? (
            <p className="sidebar-note error">无法读取服务配置：{configError}</p>
          ) : null}
          {notice ? (
            <button type="button" className="sidebar-notice" onClick={clearNotice} title="点击关闭">
              {notice.message}
            </button>
          ) : null}

          <div className="root-row">
            <button
              type="button"
              className="root-button"
              title={root ?? ''}
              onClick={() => setPicking(true)}
              disabled={!root}
            >
              <span className="root-label">{root ? shortRoot(root) : '选择目录'}</span>
              <span className="root-hint">切换</span>
            </button>
            <button
              type="button"
              className="rail-toggle"
              title="重新扫描目录"
              aria-label="重新扫描目录"
              onClick={reload}
              disabled={loading || !root}
            >
              <RefreshIcon />
            </button>
          </div>

          {listing && buckets.length > 0 ? (
            <div className="time-filter">
              <div className="time-filter-head">
                <span className="time-filter-label">按日筛选</span>
                <span className="time-filter-span">
                  {buckets[0].key.slice(5)} — {buckets[buckets.length - 1].key.slice(5)}
                </span>
                <button
                  type="button"
                  className={
                    selectedDays.size === 0 ? 'time-filter-clear active' : 'time-filter-clear'
                  }
                  title="不按日期筛选，显示全部会话"
                  onClick={() => setSelectedDays(new Set())}
                >
                  全部
                </button>
                <button
                  type="button"
                  className="time-filter-clear"
                  title="回到只看今天"
                  onClick={() => setSelectedDays(new Set([todayKey()]))}
                >
                  今天
                </button>
              </div>
              <div className="time-bars" role="group" aria-label="按会话日期筛选">
                {buckets.map((bucket) => {
                  const active = selectedDays.has(bucket.key)
                  return (
                    <button
                      key={bucket.key}
                      type="button"
                      className={active ? 'time-bar active' : 'time-bar'}
                      // 宽度按当天会话数占全部的比例分配，最少留 3px 以便点中。
                      style={{ flexGrow: bucket.count }}
                      title={`${bucket.key} · ${bucket.count} 个会话${active ? '（已选中）' : ''}`}
                      aria-pressed={active}
                      onClick={() =>
                        setSelectedDays((current) => {
                          const next = new Set(current)
                          // 再点一次就是反选
                          if (next.has(bucket.key)) next.delete(bucket.key)
                          else next.add(bucket.key)
                          return next
                        })
                      }
                    />
                  )
                })}
              </div>
            </div>
          ) : null}

          {searchOpen ? (
            <div className="sidebar-search">
              <input
                type="search"
                value={query}
                placeholder="搜索会话"
                aria-label="搜索会话"
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  event.stopPropagation()
                  setQuery('')
                  setSearchOpen(false)
                }}
              />
            </div>
          ) : null}

          <div className="session-list">
            {error ? <p className="sidebar-note error">{error}</p> : null}
            {!error && loading && groups.length === 0 ? (
              <p className="sidebar-note">读取中…</p>
            ) : null}
            {!error && !loading && groups.length === 0 ? (
              <p className="sidebar-note">
                {query
                  ? '没有命中的会话'
                  : selectedDays.size > 0
                    ? `所选的 ${selectedDays.size} 天里没有会话`
                    : '这个目录下没有 .jsonl 会话文件'}
              </p>
            ) : null}

            {liveRows.length > 0 ? (
              <section className="pinned-section live-section">
                <h3 className="section-label">
                  运行中 <span className="session-group-count">{liveRows.length}</span>
                </h3>
                <ul className="session-items">
                  {liveRows.map(({ session, row }) => (
                    <li key={session.sessionId}>
                      <button
                        type="button"
                        className={`session-item${row && row.id === selected?.id ? ' active' : ''}`}
                        title={
                          row
                            ? `${session.name ?? session.sessionId}\n${session.sessionFile ?? ''}`
                            : `文件还没写入：${session.sessionFile ?? session.sessionId}`
                        }
                        onClick={() => {
                          if (row) select(row)
                        }}
                        disabled={!row}
                      >
                        <span className="name">
                          <span
                            className={`session-live-dot is-${session.status}`}
                            aria-label={session.status === 'running' ? '运行中' : '空闲'}
                          />
                          {session.name ?? row?.name ?? session.sessionId.slice(0, 12)}
                          {!session.sameHost ? '（远程）' : ''}
                        </span>
                        <span className="meta">
                          <span>{session.model ?? '模型未知'}</span>
                          <span>{session.sameHost ? (row ? formatAge(row.modified) : '待写入') : session.host}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {liveError ? (
              <p className="sidebar-note" title={liveError}>
                运行态读取失败，只显示历史会话
              </p>
            ) : null}

            {pinned.length > 0 ? (
              <section className="pinned-section">
                <h3 className="section-label">特别关注</h3>
                {pinned.map(renderGroup)}
              </section>
            ) : null}

            {pinned.length > 0 && rest.length > 0 ? (
              <h3 className="section-label">全部项目</h3>
            ) : null}

            {rest.map(renderGroup)}
          </div>

          <p className="sidebar-foot">
            {listing ? `${listing.sessions.length} 个会话 · ${groups.length} 个项目` : '—'}
            {listing && listing.pendingDetails > 0 ? ` · 补明细 ${listing.pendingDetails}` : ''}
            {listing?.truncated ? ' · 已截断' : ''}
            {daySummary ? ` · ${daySummary}` : ''}
          </p>
        </div>
      </SidebarFrame>
      <ContextMenu state={menu} onClose={() => setMenu(null)} container={containerRef.current} />
    </div>
  )
}
