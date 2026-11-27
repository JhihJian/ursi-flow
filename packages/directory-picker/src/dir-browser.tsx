import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { basename, build, childOf, crumbs, parse } from '@ursi/location'
import type { Location } from '@ursi/location'
import { classifyInput, filterEntries } from './path'
import { useDirectoryListing } from './use-directory-listing'
import type { DeviceOption, ListDirFn } from './types'
import './directory-picker.css'

export interface DirBrowserProps {
  /** 数据注入：任意导航目标（位置 URI 或本机简写）→ 子目录清单。 */
  listDir: ListDirFn
  /** 初始位置；URI，或 `~` 这类由服务端解析的本机简写。 */
  initialPath: string
  /** 确认选择当前位置，收到的是 URI。 */
  onSelect: (uri: string) => void
  /** 取消（组件不自己管理开关状态）。 */
  onCancel: () => void
  /** 可切换的设备；本机固定在第一项。不传则不渲染设备选择。 */
  devices?: DeviceOption[]
  /** 快捷目录（位置 URI），展示在列表上方，只显示目录名。 */
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

/** 本机固定项：面包屑第一级与设备下拉的第一项。 */
const LOCAL_LABEL = '本机'

/** 未拿到清单前的锚点：初始目标是 URI 就用它，`~` 这类本机简写则落在设备根，清单回来后即被覆盖。 */
function anchorOf(target: string): Location {
  if (!target.includes('://')) return build('file', '/')
  try {
    return parse(target)
  } catch {
    return build('file', '/')
  }
}

/** 设备根：本机 `file:///`，远程 `ssh://<设备>/`。 */
function rootOf(loc: Location): string {
  return loc.scheme === 'file' ? build('file', '/').uri : build('ssh', loc.device!, '/').uri
}

/** 快捷目录按钮文案：目录名；根目录显示「本机」或设备名。 */
function suggestionLabel(uri: string): string {
  try {
    const loc = parse(uri)
    return loc.path === '/' ? (loc.scheme === 'file' ? LOCAL_LABEL : loc.device!) : basename(loc)
  } catch {
    return uri
  }
}

/**
 * 目录浏览主体：设备切换 + 面包屑 + 路径/过滤二合一输入 + 子目录列表 + 确认按钮。
 *
 * 交互约定：
 * - 输入含 `://`、`/`（或 `~`、`.`、`..`）时回车当路径导航，否则回车选中唯一过滤命中。
 * - ↑↓ 在列表内移动高亮，回车进入高亮目录，Esc 先清过滤再交给 onCancel。
 * - IME 组合期不抢按键；Enter/Escape 用 stopPropagation，不抢占宿主快捷键。
 * - 只列子目录：本组件用于「选目录」，不浏览文件。
 */
export function DirBrowser({
  listDir,
  initialPath,
  onSelect,
  onCancel,
  devices,
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

  const current = listing?.location ?? anchorOf(initialPath)
  const isPathMode = classifyInput(typed) === 'path'
  const visibleEntries = useMemo(
    () => filterEntries(listing?.entries ?? [], isPathMode ? '' : typed),
    [listing, isPathMode, typed],
  )
  const trail = useMemo(() => crumbs(current), [current.uri])

  const submit = () => {
    const value = typed.trim()
    if (!value) return
    if (isPathMode) {
      navigate(value)
      setTyped('')
      setActiveIndex(-1)
    } else if (listing && visibleEntries.length === 1) {
      // 过滤唯一命中：回车直接进入，省一次点击。
      navigate(childOf(listing.location, visibleEntries[0].name).uri)
      setTyped('')
      setActiveIndex(-1)
    }
  }

  const enter = (name: string) => {
    if (!listing) return
    navigate(childOf(listing.location, name).uri)
    setTyped('')
    setActiveIndex(-1)
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
        enter(visibleEntries[activeIndex].name)
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
    if (!loading) onSelect(current.uri)
  }

  const switchDevice = (device: string) => {
    navigate(device ? build('ssh', device, '/').uri : build('file', '/').uri)
  }

  return (
    <div className="dp">
      <div className="dp-crumbs">
        {devices && devices.length > 0 ? (
          <select
            className="dp-device"
            aria-label="设备"
            value={current.scheme === 'file' ? '' : (current.device ?? '')}
            disabled={loading}
            onChange={(event) => switchDevice(event.target.value)}
          >
            <option value="">{LOCAL_LABEL}</option>
            {devices.map((option) => (
              <option key={option.device} value={option.device}>
                {option.label ?? option.device}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="dp-crumb-btn"
          onClick={() => listing?.parent && navigate(listing.parent.uri)}
          disabled={!listing?.parent || loading}
          title="上一级"
          aria-label="上一级"
        >
          ↑
        </button>
        <button
          type="button"
          className="dp-crumb-btn"
          onClick={() => navigate(current.scheme === 'file' ? '~' : rootOf(current))}
          disabled={loading}
          title="主目录"
          aria-label="主目录"
        >
          ~
        </button>
        <button
          type="button"
          className={`dp-crumb${trail.length === 0 ? ' dp-crumb--current' : ''}`}
          onClick={() => navigate(rootOf(current))}
        >
          {current.scheme === 'file' ? LOCAL_LABEL : (current.device ?? '')}
        </button>
        {trail.map((crumb) => (
          <span key={crumb.loc.uri} className="dp-crumb-wrap">
            <span className="dp-crumb-sep">›</span>
            <button
              type="button"
              className={`dp-crumb${crumb.loc.uri === current.uri ? ' dp-crumb--current' : ''}`}
              onClick={() => navigate(crumb.loc.uri)}
              title={crumb.loc.uri}
            >
              {crumb.name}
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
              {suggestionLabel(suggested)}
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
                title={listing ? childOf(listing.location, entry.name).uri : entry.name}
                onClick={() => enter(entry.name)}
              >
                <span className="dp-row-name">{entry.name}</span>
                {entry.note ? <span className="dp-row-note">{entry.note}</span> : null}
              </button>
            </li>
          ))
        )}
      </ul>

      <p className="dp-hint" title={current.uri}>
        {current.uri}
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
