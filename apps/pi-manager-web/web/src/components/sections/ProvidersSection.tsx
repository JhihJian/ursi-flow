import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AuthEntryView, AuthListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { Badge, EmptyState, ErrorBanner, Field, Loading, Notice } from '../ui'

/**
 * 凭据（auth.json）：provider 列表 + 掩码展示 + 设置/覆盖 API key、删除条目。
 * 明文 key 只在提交瞬间出现在请求体里，界面永不回显。
 */

export function ProvidersSection({ home }: { home: string }) {
  const [listing, setListing] = useState<AuthListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      const data = await api.getAuth(home)
      setListing(data)
      setError(null)
      setSelected((current) =>
        current && data.entries.some((e) => e.provider === current) ? current : (data.entries[0]?.provider ?? null),
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

  const selectedEntry = listing.entries.find((e) => e.provider === selected) ?? null

  async function saveKey(provider: string, apiKey: string): Promise<boolean> {
    return runWrite(`保存 ${provider} 的 API key`, async () => {
      await api.putAuthApiKey(home, provider, apiKey, listing!.revision)
      await reload()
    })
  }

  async function removeEntry(provider: string): Promise<boolean> {
    return runWrite(`删除 ${provider} 的凭据`, async () => {
      await api.deleteAuthEntry(home, provider, listing!.revision)
      await reload()
    })
  }

  return (
    <div className="split-view">
      <div className="split-list" role="listbox" aria-label="凭据 provider">
        {listing.entries.map((entry) => (
          <button
            key={entry.provider}
            type="button"
            className="list-item"
            role="option"
            aria-current={entry.provider === selected}
            onClick={() => setSelected(entry.provider)}
          >
            <span className="list-item-main">
              <div className="list-item-title">{entry.provider}</div>
              <div className="list-item-sub">{entry.type === 'oauth' ? 'OAuth' : 'API key'}</div>
            </span>
            <span className="list-item-badges">
              <Badge tone={entry.type === 'oauth' ? 'accent' : 'ok'}>
                {entry.type === 'oauth' ? 'oauth' : 'key'}
              </Badge>
            </span>
          </button>
        ))}
        {listing.entries.length === 0 ? <EmptyState title="auth.json 里还没有凭据" /> : null}
        <div style={{ marginTop: 'auto', paddingTop: 'var(--space-3)' }}>
          <NewProviderForm onSave={saveKey} />
        </div>
      </div>

      <div className="split-detail">
        <div className="split-detail-inner">
          {selectedEntry ? (
            <ProviderDetail
              key={selectedEntry.provider}
              entry={selectedEntry}
              revision={listing.revision}
              exists={listing.exists}
              onSave={saveKey}
              onRemove={removeEntry}
            />
          ) : (
            <EmptyState title="选择左侧 provider" hint="或新增一个 API key 凭据。" />
          )}
          <Notice>
            凭据原文不会回传到页面：列表里显示的是掩码。OAuth 凭据只能由 pi CLI 刷新，这里只读展示。
          </Notice>
        </div>
      </div>
    </div>
  )
}

function ProviderDetail({
  entry,
  revision,
  exists,
  onSave,
  onRemove,
}: {
  entry: AuthEntryView
  revision: string
  exists: boolean
  onSave: (provider: string, apiKey: string) => Promise<boolean>
  onRemove: (provider: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <h2 className="settings-section-title">{entry.provider}</h2>
        <p className="settings-section-description">
          {entry.type === 'oauth' ? 'OAuth 凭据（只读）' : 'API key 凭据'}
        </p>
      </header>
      <div className="settings-section-body">
        <div className="kv-grid">
          <span className="kv-key">凭据状态</span>
          <span className="kv-value">
            {entry.masked ? <span className="masked-value">{entry.masked}</span> : '已授权（OAuth）'}
          </span>
        </div>
        <Field label="设置 / 覆盖 API key" hint="提交后立即写回 auth.json（0600）；界面不回显。">
          <div className="field-row">
            <input
              className="input"
              type="password"
              value={draft}
              placeholder="sk-…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  void onSave(entry.provider, draft.trim()).then((ok) => {
                    if (ok) setDraft('')
                  })
                }
              }}
            />
            <button
              type="button"
              className="btn primary"
              disabled={!draft.trim()}
              onClick={() => {
                void onSave(entry.provider, draft.trim()).then((ok) => {
                  if (ok) setDraft('')
                })
              }}
            >
              保存
            </button>
          </div>
        </Field>
        <div className="field-row">
          <button
            type="button"
            className="btn danger"
            disabled={!exists}
            onClick={() => {
              if (window.confirm(`删除 ${entry.provider} 的凭据？该操作会写备份 .bak-manager。`)) {
                void onRemove(entry.provider)
              }
            }}
          >
            删除此凭据
          </button>
          <span className="mono-dim">revision {revision.slice(0, 12)}…</span>
        </div>
      </div>
    </section>
  )
}

function NewProviderForm({ onSave }: { onSave: (provider: string, apiKey: string) => Promise<boolean> }) {
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(provider)
  return (
    <div className="stack">
      <div className="section-caption">新增 API key</div>
      <input
        className="input"
        value={provider}
        placeholder="provider 名，如 zenmux"
        onChange={(e) => setProvider(e.target.value)}
      />
      <input
        className="input"
        type="password"
        value={key}
        placeholder="API key"
        onChange={(e) => setKey(e.target.value)}
      />
      <button
        type="button"
        className="btn primary"
        disabled={!valid || !key.trim()}
        onClick={() => {
          void onSave(provider, key.trim()).then((ok) => {
            if (ok) {
              setProvider('')
              setKey('')
            }
          })
        }}
      >
        保存凭据
      </button>
    </div>
  )
}
