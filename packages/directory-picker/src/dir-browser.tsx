import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { classifyInput, filterEntries, joinPath, pathSegments } from './path'
import { useDirectoryListing } from './use-directory-listing'
import type { ListDirFn } from './types'
import './directory-picker.css'

export interface DirBrowserProps {
  /** 数据注入：任意路径 → 子目录清单。 */
  listDir: ListDirFn
  /** 初始目录；`~` 由服务端展开。 */
  initialPath: string
  /** 确认选择当前目录。 */
  onSelect: (path: string) => void
  /** 取消（组件不自己管理开关状态）。 */
  onCancel: () => void
  /** 快捷目录（如各 home 的默认位置），展示在列表上方。 */
  suggestions?: string[]
  /** 输入框占位文案。 */
  placeholder?: string
  /** 变化后重新加载 initialPath 的外部信号（如调用方数据刷新）。 */
  reloadKey?: number
  /** 列表为空时的提示。 */
  emptyText?: string
  /** 确认按钮文案。 */
  selectLabel?: string
}

/**
 * 目录浏览主体：面包屑 + 路径/过滤二合一输入 + 子目录列表 + 确认按钮。
 *
 * 交互约定：
 * - 输入含 `/`（或 `~`、`.`、`..`）时回车当路径导航，否则回车选中唯一过滤命中。
 * - ↑↓ 在列表内移动高亮，回车进入高亮目录，Esc 先清过滤再交给 onCancel。
 * - IME 组合期不抢按键；Enter/Escape 用 stopPropagation，不抢占宿主快捷键。
 * - 只列子目录：本组件用于「选目录」，不浏览文件。
 */
export function DirBrowser({
  listDir,
  initialPath,
  onSelect,
  onCancel,
  suggestions = [],
  placeholder = '输入路径回车跳转，或输入文字过滤',
  reloadKey = 0,
  emptyText = '没有子目录',
  selectLabel = '选择此目录',
}: DirBrowserProps) {
  const { listing, loading, error, navigate, refresh } = useDirectoryListing(
    listDir,
    initialPath,
    reloadKey,
  )
  const [typed, setTyped] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const listRef = useRef<HTMLUListElement>(null)

  const currentPath = listing?.path ?? initialPath
  const isPathMode = classifyInput(typed) === 'path'
  const visibleEntries = useMemo(
    () => filterEntries(listing?.entries ?? [], isPathMode ? '' : typed),
    [listing, isPathMode, typed],
  )
  const crumbs = useMemo(() => pathSegments(currentPath), [currentPath])

  const submit = () => {
    const value = typed.trim()
    if (!value) return
    if (isPathMode) {
      navigate(value)
      setTyped('')
      setActiveIndex(-1)
    } else if (visibleEntries.length === 1) {
      // 过滤唯一命中：回车直接进入，省一次点击。
      navigate(joinPath(currentPath, visibleEntries[0].name))
      setTyped('')
      setActiveIndex(-1)
    }
  }

  const moveHighlight = (delta: number) => {
    if (visibleEntries.length === 0) return
    setActiveIndex((current) => {
      const base = current >= 0 ? current : -1
      const next = Math.min(Math.max(base + delta, 0), visibleEntries.length - 1)
      const row = listRef.current?.children[next] as HTMLElement | undefined
      row?.scrollIntoView({ block: 'nearest' })
      return next
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // IME 组合期（拼音候选中）不处理任何导航键。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (activeIndex >= 0 && !isPathMode) {
        navigate(joinPath(currentPath, visibleEntries[activeIndex].name))
        setTyped('')
        setActiveIndex(-1)
      } else {
        submit()
      }
      return
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (typed) {
        setTyped('')
        setActiveIndex(-1)
      } else {
        onCancel()
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveHighlight(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveHighlight(-1)
    }
  }

  const confirm = () => {
    if (!loading) onSelect(currentPath)
  }

  return (
    <div className="dp">
      <div className="dp-crumbs">
        <button
          type="button"
          className="dp-crumb-btn"
          onClick={() => listing?.parent && navigate(listing.parent)}
          disabled={!listing?.parent || loading}
          title="上一级"
          aria-label="上一级"
        >
          ↑
        </button>
        <button
          type="button"
          className="dp-crumb-btn"
          onClick={() => navigate('~')}
          disabled={loading}
          title="主目录"
          aria-label="主目录"
        >
          ~
        </button>
        <button
          type="button"
          className={`dp-crumb${crumbs.length === 0 ? ' dp-crumb--current' : ''}`}
          onClick={() => navigate('/')}
        >
          /
        </button>
        {crumbs.map((segment, index) => (
          <span key={segment.path} className="dp-crumb-wrap">
            <span className="dp-crumb-sep">›</span>
            <button
              type="button"
              className={`dp-crumb${index === crumbs.length - 1 ? ' dp-crumb--current' : ''}`}
              onClick={() => navigate(segment.path)}
              title={segment.path}
            >
              {segment.name}
            </button>
          </span>
        ))}
      </div>

      <div className="dp-input-row">
        <input
          className="dp-input"
          type="text"
          value={typed}
          placeholder={placeholder}
          aria-label="路径或过滤"
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setTyped(event.target.value)
            setActiveIndex(-1)
          }}
          onKeyDown={handleKeyDown}
        />
        <button type="button" className="dp-btn" onClick={refresh} disabled={loading} title="刷新">
          刷新
        </button>
      </div>

      {error ? <p className="dp-error">{error}</p> : null}

      {suggestions.length > 0 ? (
        <div className="dp-suggestions">
          {suggestions.map((suggested) => (
            <button
              key={suggested}
              type="button"
              className="dp-suggestion"
              title={suggested}
              onClick={() => navigate(suggested)}
            >
              {suggested}
            </button>
          ))}
        </div>
      ) : null}

      <ul className="dp-list" ref={listRef}>
        {loading ? (
          <li className="dp-empty">读取中…</li>
        ) : visibleEntries.length === 0 ? (
          <li className="dp-empty">{error ? '无法读取该目录' : emptyText}</li>
        ) : (
          visibleEntries.map((entry, index) => (
            <li key={entry.name}>
              <button
                type="button"
                className={`dp-row${index === activeIndex ? ' dp-row--active' : ''}`}
                title={joinPath(currentPath, entry.name)}
                onClick={() => {
                  navigate(joinPath(currentPath, entry.name))
                  setTyped('')
                  setActiveIndex(-1)
                }}
              >
                <span className="dp-row-name">{entry.name}</span>
                {entry.note ? <span className="dp-row-note">{entry.note}</span> : null}
              </button>
            </li>
          ))
        )}
      </ul>

      <p className="dp-hint" title={currentPath}>
        {currentPath}
      </p>

      <div className="dp-foot">
        <button type="button" className="dp-btn" onClick={onCancel}>
          取消
        </button>
        <span className="dp-spacer" />
        <button type="button" className="dp-btn dp-btn--primary" onClick={confirm} disabled={loading}>
          {selectLabel}
        </button>
      </div>
    </div>
  )
}
