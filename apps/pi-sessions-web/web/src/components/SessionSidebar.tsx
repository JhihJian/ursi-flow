import { useMemo, useState } from 'react'
import type { SessionRow } from '@/api'
import {
  defaultFoldedGroups,
  formatAge,
  groupSessions,
  sessionMeta,
  sessionTitle,
  shortRoot,
} from '@/lib/format'
import type { Listing } from '@/api'
import { RootPicker } from './RootPicker'

/** 每个项目组默认显示这么多条会话，「显示更多」一次再放 20 条。 */
const GROUP_VISIBLE = 8
const SHOW_MORE_STEP = 20

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
  collapsed: boolean
  onCollapse: () => void
  onExpand: () => void
}

/**
 * 会话侧面板：上方是根目录与搜索，下面是按项目分组的会话，
 * 结构与 todo-web 的项目栏一致（衬线小标题、等宽次信息、直角、无卡片）。
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
  collapsed,
  onCollapse,
  onExpand,
}: SessionSidebarProps) {
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [more, setMore] = useState<Record<string, number>>({})
  const [picking, setPicking] = useState(false)

  const groups = groupSessions(listing?.sessions ?? [], query)
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
          className="rail-toggle"
          title="折叠会话列表"
          aria-label="折叠会话列表"
          onClick={onCollapse}
        >
          «
        </button>
      </div>

      <div className="root-row">
        <button
          type="button"
          className="root-button"
          title={root}
          onClick={() => setPicking(true)}
        >
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

      <div className="sidebar-search">
        <input
          type="search"
          value={query}
          placeholder="搜索会话"
          aria-label="搜索会话"
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>

      <div className="session-list">
        {error ? <p className="sidebar-note error">{error}</p> : null}
        {!error && loading && groups.length === 0 ? <p className="sidebar-note">读取中…</p> : null}
        {!error && !loading && groups.length === 0 ? (
          <p className="sidebar-note">
            {query ? '没有命中的会话' : '这个目录下没有 .jsonl 会话文件'}
          </p>
        ) : null}

        {groups.map((group) => {
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
              >
                <span className="session-group-caret">{isFolded ? '▸' : '▾'}</span>
                <span className="session-group-name">{group.name}</span>
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
                      <button
                        type="button"
                        className="session-more"
                        onClick={() =>
                          setMore((current) => ({
                            ...current,
                            [group.key]: (current[group.key] ?? 0) + SHOW_MORE_STEP,
                          }))
                        }
                      >
                        显示更多 {Math.min(hidden, SHOW_MORE_STEP)}
                      </button>
                    </li>
                  ) : null}
                  {shown > GROUP_VISIBLE ? (
                    <li>
                      <button
                        type="button"
                        className="session-more"
                        onClick={() =>
                          setMore((current) => ({ ...current, [group.key]: 0 }))
                        }
                      >
                        收起
                      </button>
                    </li>
                  ) : null}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      <p className="sidebar-foot">
        {listing ? `${listing.sessions.length} 个会话 · ${groups.length} 个项目` : '—'}
        {listing && listing.pendingDetails > 0 ? ` · 补明细 ${listing.pendingDetails}` : ''}
        {listing?.truncated ? ' · 已截断' : ''}
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
    </aside>
  )
}
