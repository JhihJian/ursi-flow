import { useMemo, useState } from 'react'
import { NO_ROWS, type Listing, type SessionRow } from '../api'
import { primaryRuntime } from '../live'
import {
  dailyBuckets,
  groupSessions,
  shortRoot,
  splitPinnedGroups,
  todayKey,
  type SessionGroup,
} from '../lib/format'
import { useGroupFold } from '../hooks/useGroupFold'
import { useSidebarMenu } from '../hooks/useSidebarMenu'
import { useSessionsController } from '../sessions-context'
import { RootPicker } from './RootPicker'
import { ContextMenu } from '@ursi/sidebar'
import { RefreshIcon, SearchIcon } from './Icons'
import { SessionGroupList } from './SessionGroupList'

/** 只选一天时把它写进脚注，比「筛选 1 天」更有用。 */
const ONE_DAY = 1

export interface SessionsPanelProps {
  /** 会话页正指向的会话 id，对应的行高亮。 */
  activeId: string | null
  /** 当前目录（新对话会落在它下面），对应的组头高亮。 */
  cwd: string | null
  /** 点组头：该目录成为当前目录。 */
  onPickDir: (cwd: string) => void
  /** 点会话行：目录成为当前目录并打开这条会话。 */
  onOpen: (row: SessionRow) => void
  /** 右键「释放运行时」：由宿主注入，本模块不碰运行时。 */
  onEvict: (sessionId: string) => void
  /** 本进程装配过的会话 id：只有这些行才能释放运行时。 */
  assembledIds: ReadonlySet<string>
  /** 菜单挂载容器（侧栏根元素，不滚动），右键坐标相对它换算。 */
  menuContainer: HTMLElement | null
}

/**
 * 侧栏的会话面板：目录行、按日筛选条形、搜索与按项目分组的会话列表。
 * 外框与折叠由宿主负责，这里只管内容。
 *
 * 根目录、日期筛选、关注、运行态来自 controller，视图私有的状态在各自的 hook 里。
 * 当前页面与运行时动作不在这里，由宿主通过 props 传入。
 */
export function SessionsPanel({
  activeId,
  cwd,
  onPickDir,
  onOpen,
  onEvict,
  assembledIds,
  menuContainer,
}: SessionsPanelProps) {
  const {
    root,
    configError,
    listing,
    loading,
    error,
    query,
    setQuery,
    selectedDays,
    setSelectedDays,
    pinnedProjects,
    togglePin,
    deleteSession,
    reload,
    notice,
    clearNotice,
    picking,
    setPicking,
    setRoot,
    config,
    runtimeByPath,
    heartbeatDetected,
  } = useSessionsController()
  // 搜索默认收起成图标，点开才显示输入框。纯瞬时状态，收起时连搜索词一起清空。
  const [searchOpen, setSearchOpen] = useState(false)

  // 条形按整份列表统计，不跟着搜索与筛选变，否则选一天后其它天就消失了。
  const allRows = listing?.sessions ?? NO_ROWS
  const buckets = useMemo(() => dailyBuckets(allRows), [allRows])
  const groups = useMemo(() => groupSessions(allRows, query, selectedDays), [allRows, query, selectedDays])
  const { pinned, rest } = useMemo(
    () => splitPinnedGroups(groups, pinnedProjects),
    [groups, pinnedProjects],
  )
  const pinnedKeySet = useMemo(() => new Set(pinnedProjects), [pinnedProjects])

  const fold = useGroupFold(groups, activeId, root, { searching: query.trim().length > 0 })
  const pickGroup = (group: SessionGroup) => onPickDir(group.key)
  const menu = useSidebarMenu({
    deleteSession,
    togglePin,
    evictSession: onEvict,
    localSessionIds: assembledIds,
    menuContainer,
  })

  const liveForRow = (row: SessionRow) => primaryRuntime(runtimeByPath.get(row.path))

  // 运行态不单独成列表：存活会话在项目分组里用绿点标出，与磁盘列表是同一份清单。
  const runningCount = useMemo(
    () =>
      new Set(
        allRows.filter((row) => row.runtimes.some((item) => item.status === 'running')).map((row) => row.id),
      ).size,
    [allRows],
  )

  const daySummary = useMemo(() => {
    if (selectedDays.size === 0) return ''
    if (selectedDays.size === ONE_DAY) return `筛选 ${[...selectedDays][0].slice(5)}`
    return `筛选 ${selectedDays.size} 天`
  }, [selectedDays])

  const toggleSearch = () => {
    const next = !searchOpen
    setSearchOpen(next)
    // 收起就清空：看不见的过滤条件比失去它更糟。
    if (!next && query) setQuery('')
  }

  const emptyText = emptyMessage({ error, loading, query, selectedDays, listing, groups })

  const listProps = {
    pinnedKeys: pinnedKeySet,
    activeId,
    activeGroupKey: cwd,
    liveForRow,
    fold,
    onSelect: onOpen,
    onPickGroup: pickGroup,
    onGroupMenu: menu.projectMenu,
    onSessionMenu: menu.sessionMenu,
  }

  return (
    <div className="pisess pisess-sidebar-host">
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
            <button
              type="button"
              className={searchOpen ? 'rail-toggle active' : 'rail-toggle'}
              title={searchOpen ? '收起搜索' : '搜索会话'}
              aria-label={searchOpen ? '收起搜索' : '搜索会话'}
              aria-expanded={searchOpen}
              onClick={toggleSearch}
            >
              <SearchIcon />
            </button>
          </div>

          {listing && buckets.length > 0 ? (
            <DayFilter buckets={buckets} selectedDays={selectedDays} onChange={setSelectedDays} />
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
            {emptyText ? <p className={`sidebar-note${error ? ' error' : ''}`}>{emptyText}</p> : null}

            {heartbeatDetected ? null : (
              <p
                className="sidebar-note is-hint"
                title="设置 → 插件 → 内置扩展，一键安装后这里会显示运行中的会话"
              >
                运行中功能未开启：未检测到会话心跳插件
              </p>
            )}

            {pinned.length > 0 ? (
              <section className="pinned-section">
                <h3 className="section-label">特别关注</h3>
                <SessionGroupList groups={pinned} {...listProps} />
              </section>
            ) : null}

            {pinned.length > 0 && rest.length > 0 ? (
              <h3 className="section-label">全部项目</h3>
            ) : null}

            <SessionGroupList groups={rest} {...listProps} />
          </div>

          <p className="sidebar-foot">
            {listing ? `${listing.sessions.length} 个会话 · ${groups.length} 个项目` : '—'}
            {runningCount > 0 ? ` · ${runningCount} 个运行中` : ''}
            {listing && listing.pendingDetails > 0 ? ` · 补明细 ${listing.pendingDetails}` : ''}
            {listing?.truncated ? ' · 已截断' : ''}
            {daySummary ? ` · ${daySummary}` : ''}
          </p>
        </div>
      {picking ? (
        <div className="picker-backdrop">
          <RootPicker
            root={root ?? ''}
            defaultRoot={config?.defaultRoot ?? ''}
            suggestedRoots={config?.suggestedRoots ?? []}
            onPick={setRoot}
            onClose={() => setPicking(false)}
          />
        </div>
      ) : null}
      <ContextMenu state={menu.menu} onClose={menu.close} container={menuContainer} />
    </div>
  )
}

interface DayFilterProps {
  buckets: ReturnType<typeof dailyBuckets>
  selectedDays: ReadonlySet<string>
  onChange: (days: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => void
}

/**
 * 最近七天的条形：宽度按当天会话数分配，最少留 3px 以便点中。
 * 点一天筛选、再点反选、可多选；「全部」清空筛选，「今天」回到默认。
 */
function DayFilter({ buckets, selectedDays, onChange }: DayFilterProps) {
  return (
    <div className="time-filter">
      <div className="time-filter-head">
        <span className="time-filter-label">按日筛选</span>
        <span className="time-filter-span">
          {buckets[0].key.slice(5)} — {buckets[buckets.length - 1].key.slice(5)}
        </span>
        <button
          type="button"
          className={selectedDays.size === 0 ? 'time-filter-clear active' : 'time-filter-clear'}
          title="不按日期筛选，显示全部会话"
          onClick={() => onChange(new Set())}
        >
          全部
        </button>
        <button
          type="button"
          className={
            selectedDays.size === ONE_DAY && selectedDays.has(todayKey())
              ? 'time-filter-clear active'
              : 'time-filter-clear'
          }
          title="回到只看今天"
          onClick={() => onChange(new Set([todayKey()]))}
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
              style={{ flexGrow: bucket.count }}
              title={`${bucket.key} · ${bucket.count} 个会话${active ? '（已选中）' : ''}`}
              aria-pressed={active}
              onClick={() =>
                onChange((current) => {
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
  )
}

interface EmptyInput {
  error: string | null
  loading: boolean
  query: string
  selectedDays: ReadonlySet<string>
  listing: Listing | null
  groups: readonly SessionGroup[]
}

/**
 * 列表为空时说明原因。搜索与日期是「与」的关系：搜索没命中时先看是不是
 * 日期把候选筛没了，文案要说清是哪一个条件造成的。
 */
function emptyMessage({ error, loading, query, selectedDays, listing, groups }: EmptyInput): string | null {
  if (error) return error
  if (loading && groups.length === 0) return '读取中…'
  if (groups.length > 0) return null
  if (!listing) return null
  if (query) {
    const withoutQuery = groupSessions(listing.sessions, '', selectedDays)
    return withoutQuery.length === 0 ? '所选的日期里没有会话' : '没有命中的会话'
  }
  if (selectedDays.size > 0) {
    return selectedDays.size === ONE_DAY
      ? `所选的 ${[...selectedDays][0].slice(5)} 里没有会话`
      : `所选的 ${selectedDays.size} 天里没有会话`
  }
  return '这个目录下没有 .jsonl 会话文件'
}
