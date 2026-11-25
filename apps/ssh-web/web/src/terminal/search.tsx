import { useCallback, useEffect, useRef, useState } from 'react'
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'

/**
 * 终端内搜索面板，交互照搬 orca 的 TerminalSearch：
 * 大小写与正则开关、命中计数、增量搜索、Esc/Enter/Shift+Enter 导航。
 * 关闭时清掉高亮并清空当前命中，否则 xterm 会把上一次命中当选中内容留着。
 */

// xterm 只接受 #RRGGBB；深色主题用暗黄底，亮色主题换成浅黄底，保证两种底色上都看得见。
const DARK_DECORATIONS = {
  matchBackground: '#5c4a00',
  matchBorder: '#5c4a00',
  matchOverviewRuler: '#ffcc00',
  activeMatchBackground: '#c4580e',
  activeMatchBorder: '#ffcf6b',
  activeMatchColorOverviewRuler: '#ff9900',
}

const LIGHT_DECORATIONS = {
  matchBackground: '#ffe58a',
  matchBorder: '#ffe58a',
  matchOverviewRuler: '#c58f00',
  activeMatchBackground: '#ffb84d',
  activeMatchBorder: '#c4580e',
  activeMatchColorOverviewRuler: '#a34700',
}

interface SearchResults {
  resultIndex: number
  resultCount: number
}

const EMPTY_RESULTS: SearchResults = { resultIndex: -1, resultCount: 0 }

function buildSearchOptions(
  light: boolean,
  state: { caseSensitive: boolean; regex: boolean; incremental?: boolean },
): ISearchOptions {
  return {
    caseSensitive: state.caseSensitive,
    regex: state.regex,
    incremental: state.incremental ?? false,
    decorations: light ? LIGHT_DECORATIONS : DARK_DECORATIONS,
  }
}

/** 极窄视口下 xterm 的装饰宽度会算成负数并抛错，导航已经完成，吞掉这个错误即可。 */
function safeFind(
  search: (term: string, options?: ISearchOptions) => boolean,
  term: string,
  options: ISearchOptions,
): boolean {
  try {
    return search(term, options)
  } catch (error) {
    if (error instanceof Error && /only accepts positive integers/i.test(error.message)) return false
    throw error
  }
}

export interface TerminalSearchProps {
  open: boolean
  light: boolean
  searchAddon: SearchAddon | null
  onClose: () => void
  /** 关闭后把焦点还给终端。 */
  onRestoreFocus: () => void
}

export function TerminalSearch({
  open,
  light,
  searchAddon,
  onClose,
  onRestoreFocus,
}: TerminalSearchProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS)

  const close = useCallback(() => {
    onClose()
    onRestoreFocus()
  }, [onClose, onRestoreFocus])

  const find = useCallback(
    (direction: 'next' | 'previous', incremental = false) => {
      if (!searchAddon || !query) return
      const options = buildSearchOptions(light, { caseSensitive, regex, incremental })
      if (direction === 'next') safeFind((term, opts) => searchAddon.findNext(term, opts), query, options)
      else safeFind((term, opts) => searchAddon.findPrevious(term, opts), query, options)
    },
    [caseSensitive, light, query, regex, searchAddon],
  )

  useEffect(() => {
    if (!open) return
    const input = inputRef.current
    input?.focus()
    input?.select()
  }, [open])

  // 一个订阅同时服务面板与键盘导航，卸载时清掉装饰再清空当前命中。
  useEffect(() => {
    if (!searchAddon) return
    const disposable = searchAddon.onDidChangeResults(setResults)
    return () => {
      disposable.dispose()
    }
  }, [searchAddon])

  useEffect(() => {
    if (!searchAddon) return
    if (!open || !query) {
      searchAddon.clearDecorations()
      searchAddon.findNext('')
      setResults(EMPTY_RESULTS)
      return
    }
    find('next', true)
  }, [open, query, caseSensitive, regex, find, searchAddon])

  if (!open) return null

  const status = !query
    ? '0/0'
    : results.resultCount === 0
      ? '无结果'
      : results.resultIndex === -1
        ? `${results.resultCount}+`
        : `${results.resultIndex + 1}/${results.resultCount}`

  return (
    <div
      className="terminal-search"
      data-terminal-search-root
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          find(event.shiftKey ? 'previous' : 'next')
        }
      }}
    >
      <input
        ref={inputRef}
        value={query}
        placeholder="搜索终端内容"
        onChange={(event) => setQuery(event.target.value)}
      />
      <button
        type="button"
        aria-pressed={caseSensitive}
        aria-label="区分大小写"
        title="区分大小写"
        className={caseSensitive ? 'active' : undefined}
        onClick={() => setCaseSensitive((value) => !value)}
      >
        Aa
      </button>
      <button
        type="button"
        aria-pressed={regex}
        aria-label="正则表达式"
        title="正则表达式"
        className={regex ? 'active' : undefined}
        onClick={() => setRegex((value) => !value)}
      >
        .*
      </button>
      <span className="terminal-search-status">{status}</span>
      <button type="button" title="上一个（Shift+Enter）" onClick={() => find('previous')}>
        ↑
      </button>
      <button type="button" title="下一个（Enter）" onClick={() => find('next')}>
        ↓
      </button>
      <button type="button" title="关闭（Esc）" onClick={close}>
        ×
      </button>
    </div>
  )
}
