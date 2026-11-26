import { useMemo, useState } from 'react'
import type { CatalogCandidate, ModelCatalog } from '../../api/types'

/**
 * 启用模型（settings.json 的 enabledModels）——对齐 pi TUI 的 /scoped-models：
 * 逐条开关、可排序、可加模式，并提供 provider 级开关（pi 的 toggleProvider）。
 *
 * 清单为空（key 不存在）在 pi 里等价于「全部可用」，因此「全部启用」是删掉该 key，
 * 不提供「全部清空」清到空也不许关掉最后一条，否则语义会反转。
 * 顺序有实义：第一条启用项是新会话的启动模型，也是 Ctrl+P 循环的起点。
 */

const SOURCE_LABEL: Record<string, string> = {
  'settings.enabledModels': '已启用',
  'settings.default': '默认',
  'models.json': 'models.json',
  'models-store.json': '运行目录',
}

interface ProviderGroup {
  provider: string
  candidates: CatalogCandidate[]
  enabledCount: number
  /** 该 provider 第一条启用项在 enabledModels 里的位置，未启用为 null。 */
  firstIndex: number | null
}

export function ScopedModelsPanel({
  catalog,
  onSave,
}: {
  catalog: ModelCatalog
  onSave: (next: string[] | null, label: string) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [draft, setDraft] = useState('')
  /** null 表示跟随默认（只展开第一个有启用项的 provider），用户操作后固定为用户选择。 */
  const [expandedOverride, setExpandedOverride] = useState<Set<string> | null>(null)

  // pi 里 enabledModels 不存在等于「全部可用」，此时所有候选都按启用显示；
  // 任何一次单条关掉都会落成显式清单（和 TUI 的 toggle(null) 行为一致）。
  const allScope = catalog.scope === 'all'
  const allRefs = useMemo(() => catalog.candidates.map((c) => c.ref), [catalog.candidates])
  const enabled = allScope ? allRefs : catalog.enabledModels
  const enabledSet = new Set(enabled)
  const firstEnabled = allScope ? null : (enabled[0] ?? null)

  const groups = useMemo<ProviderGroup[]>(() => {
    const byProvider = new Map<string, CatalogCandidate[]>()
    for (const candidate of catalog.candidates) {
      const key = candidate.provider || '（无 provider，裸模型 id）'
      const list = byProvider.get(key)
      if (list) list.push(candidate)
      else byProvider.set(key, [candidate])
    }
    const out: ProviderGroup[] = []
    for (const [provider, candidates] of byProvider) {
      // 全部可用时没有 enabledIndex，按 enabled 标记统计，序号只在显式清单里才有。
      const enabledIndexes = candidates
        .map((c) => c.enabledIndex)
        .filter((index): index is number => index !== null)
      out.push({
        provider,
        candidates,
        enabledCount: candidates.filter((c) => c.enabled).length,
        firstIndex: enabledIndexes.length > 0 ? Math.min(...enabledIndexes) : null,
      })
    }
    // 有启用项的 provider 按首条启用位置排前面，其余按名字排。
    out.sort((a, b) => {
      if (a.firstIndex !== null && b.firstIndex !== null) return a.firstIndex - b.firstIndex
      if (a.firstIndex !== null) return -1
      if (b.firstIndex !== null) return 1
      return a.provider.localeCompare(b.provider)
    })
    return out
  }, [catalog.candidates])

  const providerNames = useMemo(() => groups.map((g) => g.provider), [groups])
  // 默认只展开第一个有启用项的 provider：既能立刻看到启用的模型，也不把其余组头挤出视野。
  const defaultOpen = groups.find((group) => group.enabledCount > 0)?.provider ?? ''
  const expanded = expandedOverride ?? (defaultOpen ? new Set([defaultOpen]) : new Set<string>())
  const allOpen = providerNames.length > 0 && providerNames.every((name) => expanded.has(name))

  const needle = query.trim().toLowerCase()
  const filtering = needle.length > 0 || providerFilter.length > 0
  const visibleGroups = groups
    .filter((group) => !providerFilter || group.provider === providerFilter)
    .map((group) => ({
      ...group,
      candidates: needle
        ? group.candidates.filter(
            (c) => c.ref.toLowerCase().includes(needle) || c.provider.toLowerCase().includes(needle),
          )
        : group.candidates,
    }))
    .filter((group) => group.candidates.length > 0)

  const total = catalog.candidates.length

  async function toggle(candidate: CatalogCandidate) {
    if (candidate.enabled) {
      await onSave(
        enabled.filter((ref) => ref !== candidate.ref),
        `停用 ${candidate.ref}`,
      )
      return
    }
    await onSave([...enabled, candidate.ref], `启用 ${candidate.ref}`)
  }

  async function toggleProvider(group: ProviderGroup) {
    const refs = group.candidates.map((c) => c.ref)
    const allEnabled = group.candidates.every((c) => c.enabled)
    if (allEnabled) {
      const removing = new Set(refs)
      await onSave(
        enabled.filter((ref) => !removing.has(ref)),
        `停用 ${group.provider} 的全部模型`,
      )
      return
    }
    const additions = refs.filter((ref) => !enabledSet.has(ref))
    await onSave([...enabled, ...additions], `启用 ${group.provider} 的全部模型`)
  }

  async function move(ref: string, delta: number) {
    if (allScope) return
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

  function setGroupOpen(provider: string, open: boolean) {
    setExpandedOverride((prev) => {
      const next = new Set(prev ?? expanded)
      if (open) next.add(provider)
      else next.delete(provider)
      return next
    })
  }

  return (
    <div className="scoped-panel">
      <div className="scoped-toolbar">
        <input
          className="filter-input"
          value={query}
          placeholder="按模型名过滤"
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="select scoped-provider-select"
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
        >
          <option value="">全部 provider</option>
          {providerNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <div className="scoped-toolbar-actions">
          <button
            type="button"
            className="btn small"
            onClick={() => setExpandedOverride(allOpen ? new Set() : new Set(providerNames))}
          >
            {allOpen ? '收起全部' : '展开全部'}
          </button>
          {allScope ? (
            <button
              type="button"
              className="btn small"
              onClick={() => void onSave([], '全部停用（写入空清单）')}
              title="写入空数组。pi 打开 /scoped-models 时会把空清单归一成「全部可用」，这一状态只在 settings.json 里保留"
            >
              全部停用
            </button>
          ) : (
            <button
              type="button"
              className="btn small"
              onClick={() => void onSave(null, '全部启用（删除 enabledModels）')}
              title="删除 enabledModels，等于 pi 的「全部可用」"
            >
              全部启用
            </button>
          )}
        </div>
      </div>

      <div className="scoped-meta">
        <span className="mono-dim">
          {allScope
            ? `全部可用（enabledModels 未设置）：${total} 个模型都可选`
            : catalog.scope === 'none'
              ? `全部停用（enabledModels 是空数组）：${total} 个候选都关闭`
              : `已启用 ${enabled.length} / 候选 ${total}`}
          {' · '}
          {groups.length} 个 provider
          {firstEnabled ? ` · 启动首选 ${firstEnabled}` : ''}
          {' · '}点 provider 名展开该组模型，组内最多显示一屏高，超出可单独滚动
        </span>
      </div>

      {visibleGroups.map((group) => {
        const open = filtering || expanded.has(group.provider)
        const allEnabled = group.enabledCount === group.candidates.length
        const partial = group.enabledCount > 0 && !allEnabled
        const enabledIds = group.candidates
          .filter((c) => c.enabled)
          .map((c) => c.modelId)
        const startsSession = group.firstIndex === 0
        const headHint = enabledIds.length
          ? `${group.provider}：已启用 ${enabledIds.length}/${group.candidates.length}\n${enabledIds.join('\n')}`
          : `${group.provider}：未启用任何模型，共 ${group.candidates.length} 个候选`
        return (
          <div className="provider-group" key={group.provider}>
            <div className="provider-head">
              <button
                type="button"
                className="provider-toggle"
                aria-expanded={open}
                title={headHint}
                onClick={() => setGroupOpen(group.provider, !open)}
              >
                <span className="provider-caret">{open ? '▾' : '▸'}</span>
                <span className="provider-name">{group.provider}</span>
              </button>
              <span className={`mono-dim provider-count${partial ? ' partial' : ''}`}>
                {group.enabledCount}/{group.candidates.length}
              </span>
              {startsSession ? <span className="provider-badge">启动首选</span> : null}
              <span className="spacer" />
              <button
                type="button"
                className="switch"
                aria-pressed={allEnabled}
                aria-label={`${allEnabled ? '停用' : '启用'} ${group.provider} 的全部模型`}
                title={`${allEnabled ? '停用' : '启用'} ${group.provider} 的全部模型（对齐 pi 的 toggleProvider）`}
                onClick={() => void toggleProvider(group)}
              >
                <span className="switch-track" aria-hidden />
              </button>
            </div>

            {open ? (
              <div className="provider-table-wrap">
              <table className="item-table provider-table">
                <thead>
                  <tr>
                    <th className="col-state">State</th>
                    <th className="col-order">#</th>
                    <th>Model</th>
                    <th className="col-actions" />
                  </tr>
                </thead>
                <tbody>
                  {group.candidates.map((item) => (
                    <tr key={item.ref} className={item.enabled ? 'is-selected' : undefined}>
                      <td className="col-state">
                        <button
                          type="button"
                          className="switch"
                          aria-pressed={item.enabled}
                          aria-label={`${item.enabled ? '停用' : '启用'} ${item.ref}`}
                          onClick={() => void toggle(item)}
                        >
                          <span className="switch-track" aria-hidden />
                        </button>
                      </td>
                      <td className="col-order">
                        {item.enabledIndex === null ? '—' : item.enabledIndex + 1}
                      </td>
                      <td>
                        <div className="cell-title">{item.modelId}</div>
                        <div className="cell-sub">
                          {item.sources.map((source) => SOURCE_LABEL[source] ?? source).join(' · ')}
                          {item.pattern ? ' · 模式' : ''}
                          {item.ref === firstEnabled ? ' · 启动首选' : ''}
                          {item.enabled && !item.resolvable ? ' · 文件目录里没有，由扩展或网关提供' : ''}
                        </div>
                      </td>
                      <td className="col-actions">
                        {item.enabled && item.enabledIndex !== null ? (
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
              </div>
            ) : null}
          </div>
        )
      })}

      {visibleGroups.length === 0 ? <p className="mono-dim">没有匹配的模型。</p> : null}

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
        顺序即 Ctrl+P 循环顺序，第一条是新会话的启动模型。provider 右侧开关是整组启停（对齐 pi 的
        toggleProvider）。「全部启用」是删掉 enabledModels（pi 视为全部可用），「全部停用」是写入空数组；
        pi 自己打开 /scoped-models 时会把空数组归一成全部可用，所以全部停用只在 settings.json 里保留。
        在「全部可用」状态关掉某一条或某个 provider，会把其余候选落成显式清单（与 pi 的 toggle 一致）。
        由 extensions/providers/ 注册的 provider 不写配置文件，只能手写 provider/modelId 或模式来启用。
      </p>
    </div>
  )
}
