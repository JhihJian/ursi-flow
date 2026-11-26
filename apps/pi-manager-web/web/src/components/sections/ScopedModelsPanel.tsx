import { useMemo, useState } from 'react'
import type { CatalogCandidate, ModelCatalog } from '../../api/types'

/**
 * 启用模型（settings.json 的 enabledModels）——对齐 pi TUI 的 /scoped-models：
 * 逐条开关、可排序、可加模式。清单为空（key 不存在）在 pi 里等价于「全部可用」，
 * 因此「全部启用」是删除该 key，「清空」不提供（会让语义反转）。
 * 顺序有实义：第一条启用项是新会话的启动模型，也是 Ctrl+P 循环的起点。
 */

const SOURCE_LABEL: Record<string, string> = {
  'settings.enabledModels': '已启用',
  'settings.default': '默认',
  'models.json': 'models.json',
  'models-store.json': '运行目录',
}

export function ScopedModelsPanel({
  catalog,
  onSave,
}: {
  catalog: ModelCatalog
  onSave: (next: string[] | null, label: string) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')

  const enabled = catalog.enabledModels
  const enabledSet = new Set(enabled)
  const firstEnabled = enabled[0] ?? null

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return catalog.candidates
    return catalog.candidates.filter((item) => item.ref.toLowerCase().includes(needle))
  }, [catalog.candidates, query])

  const total = catalog.candidates.length

  async function toggle(candidate: CatalogCandidate) {
    if (candidate.enabled) {
      const next = enabled.filter((ref) => ref !== candidate.ref)
      await onSave(next, `停用 ${candidate.ref}`)
      return
    }
    await onSave([...enabled, candidate.ref], `启用 ${candidate.ref}`)
  }

  async function move(ref: string, delta: number) {
    const index = enabled.indexOf(ref)
    const target = index + delta
    if (index < 0 || target < 0 || target >= enabled.length) return
    const next = [...enabled]
    ;[next[index], next[target]] = [next[target], next[index]]
    await onSave(next, `调整 ${ref} 的顺序`)
  }

  async function addDraft() {
    const ref = draft.trim()
    if (!ref) return
    if (enabledSet.has(ref)) {
      setDraft('')
      return
    }
    const ok = await onSave([...enabled, ref], `添加 ${ref}`)
    if (ok) setDraft('')
  }

  return (
    <div className="scoped-panel">
      <div className="scoped-toolbar">
        <input
          className="filter-input"
          value={query}
          placeholder="按 provider 或模型名过滤"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="scoped-toolbar-actions">
          <button
            type="button"
            className="btn small"
            onClick={() => void onSave(null, '全部启用（删除 enabledModels）')}
            disabled={catalog.enabledModels.length === 0}
            title="删除 enabledModels，等于 pi 的「全部可用」"
          >
            全部启用
          </button>
        </div>
      </div>

      <div className="scoped-meta">
        <span className="mono-dim">
          已启用 {enabled.length} / 候选 {total}
          {firstEnabled ? ` · 启动首选 ${firstEnabled}` : ' · 未限定，pi 用默认模型'}
        </span>
      </div>

      {rows.length > 0 ? (
        <table className="item-table">
          <thead>
            <tr>
              <th className="col-state">State</th>
              <th className="col-order">#</th>
              <th>Model</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.ref} className={item.enabled ? 'is-selected' : undefined}>
                <td className="col-state">
                  <button
                    type="button"
                    className="switch"
                    aria-pressed={item.enabled}
                    aria-label={`${item.enabled ? '停用' : '启用'} ${item.ref}`}
                    disabled={item.enabled && enabled.length === 1}
                    title={
                      item.enabled && enabled.length === 1
                        ? '至少保留一条启用项；要放开全部请用「全部启用」'
                        : undefined
                    }
                    onClick={() => void toggle(item)}
                  >
                    <span className="switch-track" aria-hidden />
                  </button>
                </td>
                <td className="col-order">
                  {item.enabledIndex === null ? '—' : item.enabledIndex + 1}
                </td>
                <td>
                  <div className="cell-title">{item.ref}</div>
                  <div className="cell-sub">
                    {item.sources.map((source) => SOURCE_LABEL[source] ?? source).join(' · ')}
                    {item.pattern ? ' · 模式' : ''}
                    {item.ref === firstEnabled ? ' · 启动首选' : ''}
                    {item.enabled && !item.resolvable ? ' · 文件目录里没有，由扩展或网关提供' : ''}
                  </div>
                </td>
                <td className="col-actions">
                  {item.enabled ? (
                    <span className="row-actions">
                      <button
                        type="button"
                        className="btn small"
                        aria-label="上移"
                        disabled={item.enabledIndex === 0}
                        onClick={() => void move(item.ref, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        aria-label="下移"
                        disabled={item.enabledIndex === enabled.length - 1}
                        onClick={() => void move(item.ref, 1)}
                      >
                        ↓
                      </button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mono-dim">没有匹配的模型。</p>
      )}

      <div className="field-row">
        <input
          className="input"
          value={draft}
          placeholder="添加 provider/modelId，或用模式如 sub2api-local/*"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addDraft()
          }}
        />
        <button type="button" className="btn small" onClick={() => void addDraft()} disabled={!draft.trim()}>
          添加并启用
        </button>
      </div>

      <p className="mono-dim">
        顺序即 Ctrl+P 循环顺序，第一条是新会话的启动模型。清单为空表示全部可用，所以「全部启用」是删掉
        enabledModels；至少保留一条启用项。由 extensions/providers/ 注册的 provider 不写配置文件，
        只能手写 provider/modelId 或模式来启用。
      </p>
    </div>
  )
}
