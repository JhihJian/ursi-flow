import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { Listing, SessionRow } from '@/api'
import type { SessionGroup } from '@/lib/format'
import {
  dailyBuckets,
  defaultFoldedGroups,
  formatAge,
  groupSessions,
  sessionMeta,
  sessionTitle,
  shortRoot,
  splitPinnedGroups,
} from '@/lib/format'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { RootPicker } from './RootPicker'

/** 每个项目组默认显示这么多条会话，「显示更多」一次再放 20 条。 */
const GROUP_VISIBLE = 8
const SHOW_MORE_STEP = 20
/** 列表还没到时用的空数组：保持引用稳定，免得每次渲染都重算条形。 */
const NO_ROWS: SessionRow[] = []

interface SessionSidebarProps {
  root: string
  listing: Listing | null
  loading: boolean
  error: string | null
  query: string
  onQueryChange: (query: string) => void
  selectedId: string | null
  selectedRow: SessionRow | null
  onSelect: (row: SessionRow) => void
  onReload: () => void
  onRootChange: (root: string) => void
  defaultRoot: string
  suggestedRoots: string[]
  /** 特别关注的项目键，顺序即显示顺序。 */
  pinnedProjects: string[]
  onTogglePin: (projectKey: string, pinned: boolean) => void
  onDeleteSession: (row: SessionRow) => void
  collapsed: boolean
  onCollapse: () => void
  onExpand: () => void
}

/**
 * 会话侧面板：上方是根目录与搜索，下面是按项目分组的会话，
 * 结构与 todo-web 的项目栏一致（衬线小标题、等宽次信息、直角、无卡片）。
 * 关注的项目单独成段放在最前面，项目管理与删除都从右键菜单发起。
 */
export function SessionSidebar({
  root,
  listing,
  loading,
  error,
  query,
  onQueryChange,
  selectedId,
  selectedRow,
  onSelect,
  onReload,
  onRootChange,
  defaultRoot,
  suggestedRoots,
  pinnedProjects,
  onTogglePin,
  onDeleteSession,
  collapsed,
  onCollapse,
  onExpand,
}: SessionSidebarProps) {
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [more, setMore] = useState<Record<string, number>>({})
  const [picking, setPicking] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  // 搜索默认收起成图标，点开才显示输入框；收起时清空，避免看不见的过滤条件。
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectedDays, setSelectedDays] = useState<ReadonlySet<string>>(new Set())
  // 确认菜单要落在原菜单位置上：菜单关闭后 state 已清空，位置另存一份。
  const menuAt = useRef({ x: 0, y: 0 })

  // 条形按整份列表统计，不跟着搜索与筛选变，否则选一天后其它天就消失了。
  const allRows = listing?.sessions ?? NO_ROWS
  const buckets = useMemo(() => dailyBuckets(allRows), [allRows])
  const groups = groupSessions(allRows, query, selectedDays)
  const { pinned, rest } = splitPinnedGroups(groups, pinnedProjects)
  const pinnedKeySet = useMemo(() => new Set(pinnedProjects), [pinnedProjects])
  // 用户点过的组按用户选择，没点过的按默认规则（第一组与选中会话所在的组展开）。
  const foldedByDefault = useMemo(
    () => defaultFoldedGroups(groups, selectedId),
    [groups, selectedId],
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

  /** 项目组右键：关注 / 取消关注。写操作在局域网访问时禁用并说明原因。 */
  const projectMenu = (event: ReactMouseEvent, group: SessionGroup) => {
    const isPinned = pinnedKeySet.has(group.key)
    openMenu(event, [
      {
        label: isPinned ? '取消特别关注' : '设为特别关注',
        onSelect: () => onTogglePin(group.key, !isPinned),
      },
    ], group.name)
  }

  /** 会话行右键：打开、复制标识、删除。 */
  const sessionMenu = (event: ReactMouseEvent, row: SessionRow) => {
    openMenu(
      event,
      [
        { label: '打开', onSelect: () => onSelect(row) },
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
        { label: '删除会话文件', danger: true, onSelect: () => onDeleteSession(row) },
        { label: '取消', onSelect: () => undefined },
      ],
    })
  }

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
                  className={row.id === selectedId ? 'session-item active' : 'session-item'}
                  title={`${sessionTitle(row)}\n${row.cwd || row.path}`}
                  onClick={() => onSelect(row)}
                  onContextMenu={(event) => sessionMenu(event, row)}
                >
                  <span className="name">{sessionTitle(row)}</span>
                  <span className="meta">
                    <span>{formatAge(row.modified)}</span>
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

  if (collapsed) {
    const summary = selectedRow ? `${sessionTitle(selectedRow)} · ${sessionMeta(selectedRow)}` : '未选择会话'
    return (
      <aside className="sidebar sidebar-collapsed">
        <button
          type="button"
          className="rail-toggle"
          title="展开会话列表"
          aria-label="展开会话列表"
          onClick={onExpand}
        >
          »
        </button>
        <div className="collapsed-rail">
          <button
            type="button"
            className="collapsed-project"
            title={`${summary}。${root}`}
            aria-label={`${summary}。展开会话列表`}
            onClick={onExpand}
          >
            <span className="collapsed-project-name">
              {selectedRow ? sessionTitle(selectedRow) : 'Pi Sessions'}
            </span>
            <span className="collapsed-project-meta">
              {selectedRow ? ` · ${sessionMeta(selectedRow)}` : ` · ${groups.length} 个项目`}
            </span>
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h2 className="sidebar-title">Sessions</h2>
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
            if (!next && query) onQueryChange('')
          }}
        >
          ⌕
        </button>
        <button
          type="button"
          className="rail-toggle"
          title="折叠会话列表"
          aria-label="折叠会话列表"
          onClick={onCollapse}
        >
          «
        </button>
      </div>

      <div className="root-row">
        <button type="button" className="root-button" title={root} onClick={() => setPicking(true)}>
          <span className="root-label">{shortRoot(root)}</span>
          <span className="root-hint">切换</span>
        </button>
        <button
          type="button"
          className="rail-toggle"
          title="重新扫描目录"
          aria-label="重新扫描目录"
          onClick={onReload}
          disabled={loading}
        >
          ↻
        </button>
      </div>

      {buckets.length > 0 ? (
        <div className="time-filter">
          <div className="time-filter-head">
            <span className="time-filter-label">按日筛选</span>
            <span className="time-filter-span">
              {buckets[0].key.slice(5)} — {buckets[buckets.length - 1].key.slice(5)}
            </span>
            {selectedDays.size > 0 ? (
              <button
                type="button"
                className="time-filter-clear"
                onClick={() => setSelectedDays(new Set())}
              >
                清除
              </button>
            ) : null}
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
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              onQueryChange('')
              setSearchOpen(false)
            }}
          />
        </div>
      ) : null}

      <div className="session-list">
        {error ? <p className="sidebar-note error">{error}</p> : null}
        {!error && loading && groups.length === 0 ? <p className="sidebar-note">读取中…</p> : null}
        {!error && !loading && groups.length === 0 ? (
          <p className="sidebar-note">
            {query || selectedDays.size > 0 ? '没有命中的会话' : '这个目录下没有 .jsonl 会话文件'}
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
        {selectedDays.size > 0 ? ` · 筛选 ${selectedDays.size} 天` : ''}
      </p>

      {picking ? (
        <RootPicker
          root={root}
          defaultRoot={defaultRoot}
          suggestedRoots={suggestedRoots}
          onPick={(next) => {
            setPicking(false)
            onRootChange(next)
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}

      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </aside>
  )
}
