import { useCallback, useEffect, useState } from 'react'
import { fetchBrowse, type BrowseResult } from '@/api'
import { CloseIcon } from './Icons'

interface RootPickerProps {
  root: string
  defaultRoot: string
  suggestedRoots: string[]
  onPick: (root: string) => void
  onClose: () => void
}

/**
 * 选根浮层：输入绝对路径直接打开，或在目录树里逐级进入。
 * 只列出子目录与各自直接包含的 `.jsonl` 数量，用来判断哪一层才是会话目录。
 */
export function RootPicker({ root, defaultRoot, suggestedRoots, onPick, onClose }: RootPickerProps) {
  const [path, setPath] = useState(root)
  const [typed, setTyped] = useState('')
  const [listing, setListing] = useState<BrowseResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback(async (target: string) => {
    try {
      const next = await fetchBrowse(target)
      setListing(next)
      setPath(next.path)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => {
    void open(root || defaultRoot)
  }, [open, root, defaultRoot])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = () => {
    const value = typed.trim()
    if (!value) return
    void open(value)
  }

  return (
    <div className="picker-backdrop" role="dialog" aria-modal="true" aria-label="选择会话目录">
      <div className="picker">
        <div className="picker-head">
          <h2 className="picker-title">选择会话目录</h2>
          <button type="button" className="rail-toggle" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>

        <div className="picker-path">
          <code title={path}>{path}</code>
        </div>

        <div className="picker-input">
          <input
            type="text"
            value={typed}
            placeholder="绝对路径，例如 ~/.pi/agent/sessions"
            aria-label="绝对路径"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
          <button type="button" className="picker-action" onClick={submit}>
            打开
          </button>
        </div>

        {suggestedRoots.length > 0 ? (
          <div className="picker-suggestions">
            {suggestedRoots.map((suggested) => (
              <button
                key={suggested}
                type="button"
                className="picker-suggestion"
                title={suggested}
                onClick={() => void open(suggested)}
              >
                {suggested}
              </button>
            ))}
          </div>
        ) : null}

        {error ? <p className="sidebar-note error">{error}</p> : null}

        <ul className="picker-list">
          {listing?.dirs.map((dir) => (
            <li key={dir.path}>
              <button
                type="button"
                className="picker-dir"
                title={dir.path}
                onClick={() => void open(dir.path)}
              >
                <span className="picker-dir-name">{dir.name}</span>
                <span className="picker-dir-count">
                  {dir.sessions > 0 ? `${dir.sessions} 个会话` : '—'}
                </span>
              </button>
            </li>
          ))}
          {listing && listing.dirs.length === 0 ? (
            <li className="sidebar-note">没有子目录</li>
          ) : null}
        </ul>

        <div className="picker-foot">
          <button
            type="button"
            className="picker-action"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void open(listing.parent)}
          >
            上一级
          </button>
          <span className="picker-spacer" />
          <button type="button" className="picker-action" onClick={onClose}>
            取消
          </button>
          <button type="button" className="picker-action primary" onClick={() => onPick(path)}>
            使用这个目录
          </button>
        </div>
      </div>
    </div>
  )
}
