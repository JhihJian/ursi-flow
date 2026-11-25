import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AuthEntryView, AuthListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { EmptyState, ErrorBanner, Field, Loading } from '../ui'

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
    <section className="section">
      <header className="section-head">
        <h1 className="section-title">凭据</h1>
        <span className="section-desc">auth.json · 凭据原文永不回传，页面只显示掩码</span>
      </header>
      {listing.entries.length > 0 ? (
        <table className="item-table">
          <thead>
            <tr>
              <th className="col-state">Type</th>
              <th>Provider</th>
              <th className="col-size">Key</th>
            </tr>
          </thead>
          <tbody>
            {listing.entries.map((entry) => (
              <tr
                key={entry.provider}
                className={entry.provider === selected ? 'is-selected' : undefined}
                onClick={() => setSelected(entry.provider)}
              >
                <td className="col-state">
                  <span className="state-mark" title={entry.type}>
                    {entry.type === 'oauth' ? 'oauth' : 'key'}
                  </span>
                </td>
                <td>
                  <div className="cell-title">{entry.provider}</div>
                </td>
                <td className="col-size">{entry.masked ? '已设置' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="auth.json 里还没有凭据" hint="在下方新增一个 API key。" />
      )}
      <p className="mono-dim">
        OAuth 凭据只能由 pi CLI 刷新，这里只读展示。
      </p>

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
        <NewProviderForm onSave={saveKey} />
      )}
    </section>
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
    <div className="detail-sheet">
      <div className="detail-grip" aria-hidden />
      <div className="detail-body">
        <div className="detail-head">
          <h2 className="detail-title">{entry.provider}</h2>
          <span className="detail-meta">
            {entry.type === 'oauth' ? 'OAuth 凭据（只读）' : 'API key 凭据'} · {entry.masked ?? '已授权（OAuth）'}
          </span>
        </div>
        {entry.type === 'api_key' ? (
          <div className="detail-form">
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
                  className="btn btn-primary"
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
                className="btn btn-danger"
                disabled={!exists}
                onClick={() => {
                  if (window.confirm(`删除 ${entry.provider} 的凭据？该操作会写备份 .bak-manager。`)) {
                    void onRemove(entry.provider)
                  }
                }}
              >
                删除此凭据
              </button>
              <span className="detail-hint">revision {revision.slice(0, 12)}…</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function NewProviderForm({ onSave }: { onSave: (provider: string, apiKey: string) => Promise<boolean> }) {
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(provider)
  return (
    <div className="detail-sheet">
      <div className="detail-grip" aria-hidden />
      <div className="detail-body">
        <div className="detail-head">
          <h2 className="detail-title">新增 API key</h2>
          <span className="detail-meta">provider 名只能是字母数字与 . _ -</span>
        </div>
        <div className="detail-grid">
          <Field label="Provider">
            <input
              className="input"
              value={provider}
              placeholder="如 zenmux"
              onChange={(e) => setProvider(e.target.value)}
            />
          </Field>
          <Field label="API key">
            <input
              className="input"
              type="password"
              value={key}
              placeholder="sk-…"
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
        </div>
        <div className="detail-actions">
          <button
            type="button"
            className="btn btn-primary"
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
      </div>
    </div>
  )
}
