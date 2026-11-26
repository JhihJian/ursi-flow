import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { ModelCatalog, ModelsListing, ProviderView } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { EmptyState, ErrorBanner, Field, Loading } from '../ui'

/**
 * 自定义模型（models.json）：provider 列表 + JSON 详情编辑。
 * 合并写回语义：保存时只提交当前编辑的条目（其余原样保留），
 * 条目置 null 删除。apiKey 以掩码回显，原样提交会被服务端还原成原文；
 * 改成新值就写新值。文件允许 JSONC，写回输出纯 JSON，注释会丢（UI 明示）。
 */

export function ModelsSection({ home }: { home: string }) {
  const [listing, setListing] = useState<ModelsListing | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      const [data, models] = await Promise.all([api.getModels(home), api.getModelCatalog(home)])
      setListing(data)
      setCatalog(models)
      setError(null)
      setCreating(false)
      setSelected((current) =>
        current && data.providers.some((p) => p.name === current)
          ? current
          : (data.providers[0]?.name ?? null),
      )
    } catch (err) {
      setError(describeError(err))
    }
  }, [home])

  useEffect(() => {
    void reload()
  }, [reload])

  if (error) return <ErrorBanner message={error} />
  if (!listing || !catalog) return <Loading />

  const selectedProvider = listing.providers.find((p) => p.name === selected) ?? null

  async function saveOne(name: string, entry: Record<string, unknown> | null, label: string) {
    return runWrite(label, async () => {
      await api.putModelProviders(home, { [name]: entry }, listing!.revision)
      await reload()
    })
  }

  return (
    <section className="section">
      <header className="section-head">
        <h1 className="section-title">自定义模型</h1>
        <div className="field-row">
          {listing.hadComments ? (
            <span className="section-warn">文件含注释，保存写回纯 JSON 会丢注释（备份 .bak-manager）</span>
          ) : null}
          <button type="button" className="btn small" onClick={() => setCreating(true)}>
            新增 provider
          </button>
        </div>
      </header>
      {listing.providers.length > 0 ? (
        <table className="item-table">
          <thead>
            <tr>
              <th className="col-state">Key</th>
              <th>Provider</th>
              <th className="col-size">Models</th>
            </tr>
          </thead>
          <tbody>
            {listing.providers.map((provider) => (
              <tr
                key={provider.name}
                className={provider.name === selected && !creating ? 'is-selected' : undefined}
                title={provider.baseUrl}
                onClick={() => {
                  setCreating(false)
                  setSelected(provider.name)
                }}
              >
                <td className="col-state">
                  <span className={`state-mark${provider.hasApiKey ? '' : ' off'}`}>
                    {provider.hasApiKey ? '✓' : '—'}
                  </span>
                </td>
                <td>
                  <div className="cell-title">{provider.name}</div>
                  <div className="cell-sub">{provider.baseUrl || '（无 baseUrl）'}</div>
                </td>
                <td className="col-size">{provider.modelCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="models.json 没有自建 provider"
          hint="本机的 provider 可能由扩展（extensions/providers/）注册，扩展不写入 models.json。"
        />
      )}

      <ModelCatalogSummary catalog={catalog} />

      {creating ? (
        <ProviderEditor
          key="__new__"
          provider={{ name: '', baseUrl: '', apiKeyMasked: null, hasApiKey: false, modelCount: 0, entry: { baseUrl: '', models: {} } }}
          isNew
          onSave={(name, entry) => saveOne(name, entry, `新增 provider ${name}`)}
          onCancel={() => setCreating(false)}
        />
      ) : selectedProvider ? (
        <ProviderEditor
          key={selectedProvider.name}
          provider={selectedProvider}
          isNew={false}
          onSave={(name, entry) => saveOne(name, entry, `保存 provider ${name}`)}
          onDelete={() => saveOne(selectedProvider.name, null, `删除 provider ${selectedProvider.name}`)}
        />
      ) : null}
    </section>
  )
}

function ProviderEditor({
  provider,
  isNew,
  onSave,
  onDelete,
  onCancel,
}: {
  provider: ProviderView
  isNew: boolean
  onSave: (name: string, entry: Record<string, unknown>) => Promise<boolean>
  onDelete?: () => Promise<boolean>
  onCancel?: () => void
}) {
  const [name, setName] = useState(provider.name)
  const [text, setText] = useState(() => JSON.stringify(provider.entry, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const nameValid = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)

  function parseDraft(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('provider 条目必须是 JSON 对象')
        return null
      }
      setJsonError(null)
      return parsed as Record<string, unknown>
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'JSON 解析失败')
      return null
    }
  }

  async function commit() {
    const entry = parseDraft()
    if (!entry || !nameValid) return
    await onSave(name, entry)
  }

  return (
    <div className="detail-sheet">
      <div className="detail-grip" aria-hidden />
      <div className="detail-body">
        <div className="detail-head">
          <h2 className="detail-title">{isNew ? '新增 provider' : provider.name}</h2>
          <span className="detail-meta">
            apiKey 显示为掩码时，原样保存即保留原值；改成新值则写新值。
          </span>
        </div>
        <div className="detail-form">
          <div className="detail-grid">
            <Field label="provider 名">
              <input
                className="input"
                value={name}
                readOnly={!isNew}
                onChange={(e) => setName(e.target.value)}
                placeholder="如 my-provider"
              />
            </Field>
          </div>
          <Field label="条目 JSON">
            <textarea
              className="textarea code"
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />
            {jsonError ? <span className="field-hint">{jsonError}</span> : null}
          </Field>
          <div className="field-row">
            <button type="button" className="btn btn-primary" disabled={!nameValid} onClick={() => void commit()}>
              保存
            </button>
            {onDelete ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  if (window.confirm(`删除 provider ${provider.name}？`)) void onDelete()
                }}
              >
                删除
              </button>
            ) : null}
            {onCancel ? (
              <button type="button" className="btn" onClick={onCancel}>
                取消
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 只读模型来源汇总：pi 的实际模型清单通常分散在 settings.json（启用模型）、
 * models.json（自建 provider）、models-store.json（运行态刷新的内置目录）。
 * 这里把三者并列展示，避免只看 models.json 时误以为没配模型。
 */
function ModelCatalogSummary({ catalog }: { catalog: ModelCatalog }) {
  const storeTotal = catalog.store.reduce((sum, item) => sum + item.modelCount, 0)
  const configured = catalog.configured.provider && catalog.configured.modelId
    ? `${catalog.configured.provider}/${catalog.configured.modelId}`
    : '（未设置，交给 pi 自动选）'
  return (
    <div className="catalog-summary">
      <div className="catalog-summary-head">
        <span className="field-label">模型来源</span>
        <span className="mono-dim">
          settings.json 启用 {catalog.enabledModels.length} 条 · 自建 provider{' '}
          {catalog.modelsJsonProviders.length} 个 · 运行目录 {catalog.store.length} 个 provider / {storeTotal} 个模型
        </span>
      </div>
      <div className="catalog-summary-row">
        <span className="cell-sub">当前默认</span>
        <span className="cell-title">{configured}</span>
      </div>
      {catalog.store.length > 0 ? (
        <div className="catalog-summary-row">
          <span className="cell-sub">运行目录缓存</span>
          <span className="cell-title">
            {catalog.store.map((item) => `${item.provider}（${item.modelCount}）`).join('、')}
          </span>
        </div>
      ) : null}
      <p className="mono-dim">
        运行目录来自 models-store.json，是 pi 刷新内置 provider 目录后的缓存，这里只读展示。
        由扩展注册的 provider 不写进任何配置文件，管理台按文件管理，不加载扩展。
      </p>
    </div>
  )
}
