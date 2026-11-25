import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { ModelsListing, ProviderView } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { Badge, EmptyState, ErrorBanner, Loading, Notice } from '../ui'

/**
 * 自定义模型（models.json）：provider 列表 + JSON 详情编辑。
 * 合并写回语义：保存时只提交当前编辑的条目（其余原样保留），
 * 条目置 null 删除。apiKey 以掩码回显，原样提交会被服务端还原成原文；
 * 改成新值就写新值。文件允许 JSONC，写回输出纯 JSON，注释会丢（UI 明示）。
 */

export function ModelsSection({ home }: { home: string }) {
  const [listing, setListing] = useState<ModelsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      const data = await api.getModels(home)
      setListing(data)
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
  if (!listing) return <Loading />

  const selectedProvider = listing.providers.find((p) => p.name === selected) ?? null

  async function saveOne(name: string, entry: Record<string, unknown> | null, label: string) {
    return runWrite(label, async () => {
      await api.putModelProviders(home, { [name]: entry }, listing!.revision)
      await reload()
    })
  }

  return (
    <div className="split-view">
      <div className="split-list" role="listbox" aria-label="自定义 provider">
        {listing.providers.map((provider) => (
          <button
            key={provider.name}
            type="button"
            className="list-item"
            role="option"
            aria-current={provider.name === selected && !creating}
            onClick={() => {
              setCreating(false)
              setSelected(provider.name)
            }}
          >
            <span className="list-item-main">
              <div className="list-item-title">{provider.name}</div>
              <div className="list-item-sub">{provider.baseUrl || '（无 baseUrl）'}</div>
            </span>
            <span className="list-item-badges">
              <Badge>{provider.modelCount} 模型</Badge>
              {provider.hasApiKey ? <Badge tone="ok">key</Badge> : null}
            </span>
          </button>
        ))}
        {listing.providers.length === 0 ? (
          <EmptyState title="models.json 没有 provider" hint="下方按钮新增。" />
        ) : null}
        <div style={{ marginTop: 'auto', paddingTop: 'var(--space-3)' }}>
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            新增 provider
          </button>
        </div>
      </div>

      <div className="split-detail">
        <div className="split-detail-inner">
          {listing.hadComments ? (
            <Notice tone="warn">
              models.json 当前含注释。保存时写回的是纯 JSON（与 pi CLI 行为一致），注释会丢失；
              原文件备份为 models.json.bak-manager。
            </Notice>
          ) : null}
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
          ) : (
            <EmptyState title="选择或新增 provider" />
          )}
        </div>
      </div>
    </div>
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
    <section className="settings-section">
      <header className="settings-section-header">
        <h2 className="settings-section-title">{isNew ? '新增 provider' : provider.name}</h2>
        <p className="settings-section-description">
          baseUrl、apiKey 与模型定义。apiKey 显示为掩码时，原样保存即保留原值；改成新值则写新值。
        </p>
      </header>
      <div className="settings-section-body">
        <label className="field">
          <span className="field-label">provider 名</span>
          <input
            className="input"
            value={name}
            readOnly={!isNew}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 my-provider"
            style={{ maxWidth: 260 }}
          />
        </label>
        <label className="field">
          <span className="field-label">条目 JSON</span>
          <textarea
            className="textarea code"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          {jsonError ? (
            <span className="field-hint" style={{ color: 'var(--danger)' }}>{jsonError}</span>
          ) : null}
        </label>
        <div className="field-row">
          <button type="button" className="btn primary" disabled={!nameValid} onClick={() => void commit()}>
            保存
          </button>
          {onDelete ? (
            <button
              type="button"
              className="btn danger"
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
    </section>
  )
}
