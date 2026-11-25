import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AuthEntryView, AuthListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { EmptyState, ErrorBanner, Field, Loading } from '../ui'

/**
 * 凭据（auth.json）：条目级编辑。
 * 凭据字段（key / access / refresh）回显为掩码，原样保存即保留原文；
 * 改成新值则写新值。合并写回：保存一条不影响其余条目，置 null 删除。
 */

const TYPE_LABEL: Record<AuthEntryView['type'], string> = {
  api_key: 'API key',
  oauth: 'OAuth',
  unknown: '未知',
}

function formatExpires(expires: number | null): string {
  if (!expires) return '—'
  const date = new Date(expires)
  const expired = expires < Date.now()
  const text = `${date.toLocaleString('zh-CN', { hour12: false })}`
  return expired ? `${text}（已过期）` : text
}

function newEntryTemplate(type: 'api_key' | 'oauth'): Record<string, unknown> {
  return type === 'api_key'
    ? { type: 'api_key', key: '' }
    : { type: 'oauth', access: '', refresh: '', expires: Date.now() + 3600_000 }
}

export function ProvidersSection({ home }: { home: string }) {
  const [listing, setListing] = useState<AuthListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      const data = await api.getAuth(home)
      setListing(data)
      setError(null)
      setSelected((current) =>
        current && data.entries.some((e) => e.provider === current)
          ? current
          : (data.entries[0]?.provider ?? null),
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

  async function saveOne(provider: string, entry: Record<string, unknown> | null, label: string) {
    const ok = await runWrite(label, async () => {
      await api.putAuthEntries(home, { [provider]: entry }, listing!.revision)
      setCreating(false)
      await reload()
    })
    return ok
  }

  return (
    <section className="section">
      <header className="section-head">
        <h1 className="section-title">凭据</h1>
        <div className="field-row">
          <span className="section-desc">auth.json · 凭据字段只回显掩码</span>
          <button type="button" className="btn small" onClick={() => setCreating(true)}>
            新增条目
          </button>
        </div>
      </header>
      {listing.entries.length > 0 ? (
        <table className="item-table">
          <thead>
            <tr>
              <th className="col-state">Type</th>
              <th>Provider</th>
              <th className="col-size">凭据</th>
            </tr>
          </thead>
          <tbody>
            {listing.entries.map((entry) => (
              <tr
                key={entry.provider}
                className={entry.provider === selected && !creating ? 'is-selected' : undefined}
                onClick={() => {
                  setCreating(false)
                  setSelected(entry.provider)
                }}
              >
                <td className="col-state">
                  <span className="state-mark">{TYPE_LABEL[entry.type]}</span>
                </td>
                <td>
                  <div className="cell-title">{entry.provider}</div>
                  <div className="cell-sub">
                    {entry.keyCommand
                      ? '从命令取密钥'
                      : entry.maskedFields.length > 0
                        ? `掩码字段：${entry.maskedFields.join('、')}`
                        : '（无凭据字段）'}
                  </div>
                </td>
                <td className="col-size">
                  {entry.type === 'oauth' ? formatExpires(entry.expires) : entry.maskedFields.length > 0 ? '已设置' : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="auth.json 里还没有凭据" hint="点击右上角「新增条目」。" />
      )}
      <p className="mono-dim">
        凭据原文不会回传到页面。OAuth 条目由 pi CLI 登录刷新，这里可以改字段或删除。
      </p>

      {creating ? (
        <EntryEditor
          key="__new__"
          provider=""
          entry={newEntryTemplate('api_key')}
          isNew
          onSave={(provider, next) => saveOne(provider, next, `新增凭据 ${provider}`)}
          onCancel={() => setCreating(false)}
        />
      ) : selectedEntry ? (
        <EntryEditor
          key={selectedEntry.provider}
          provider={selectedEntry.provider}
          entry={selectedEntry.entry}
          isNew={false}
          keyCommand={selectedEntry.keyCommand}
          onSave={(provider, next) => saveOne(provider, next, `保存凭据 ${provider}`)}
          onDelete={() => saveOne(selectedEntry.provider, null, `删除凭据 ${selectedEntry.provider}`)}
        />
      ) : null}
    </section>
  )
}

function EntryEditor({
  provider,
  entry,
  isNew,
  keyCommand,
  onSave,
  onDelete,
  onCancel,
}: {
  provider: string
  entry: Record<string, unknown>
  isNew: boolean
  keyCommand?: string | null
  onSave: (provider: string, entry: Record<string, unknown>) => Promise<boolean>
  onDelete?: () => Promise<boolean>
  onCancel?: () => void
}) {
  const [name, setName] = useState(provider)
  const [text, setText] = useState(() => JSON.stringify(entry, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const nameValid = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)

  function parseDraft(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('条目必须是 JSON 对象')
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
    const next = parseDraft()
    if (!next || !nameValid) return
    await onSave(name, next)
  }

  function applyType(type: 'api_key' | 'oauth') {
    setText(JSON.stringify(newEntryTemplate(type), null, 2))
  }

  return (
    <div className="detail-sheet">
      <div className="detail-grip" aria-hidden />
      <div className="detail-body">
        <div className="detail-head">
          <h2 className="detail-title">{isNew ? '新增条目' : provider}</h2>
          <span className="detail-meta">
            key / access / refresh 显示为掩码时，原样保存即保留原文；改成新值则写新值
          </span>
        </div>
        <div className="detail-form">
          {keyCommand ? (
            <p className="detail-hint">
              该条目的 key 是命令形式（{keyCommand}），pi 在首次需要时执行取密钥；管理台不会执行。
            </p>
          ) : null}
          <div className="detail-grid">
            <Field label="provider 名">
              <input
                className="input"
                value={name}
                readOnly={!isNew}
                onChange={(e) => setName(e.target.value)}
                placeholder="如 zenmux"
              />
            </Field>
          </div>
          {isNew ? (
            <div className="field-row">
              <button type="button" className="btn small" onClick={() => applyType('api_key')}>
                API key 模板
              </button>
              <button type="button" className="btn small" onClick={() => applyType('oauth')}>
                OAuth 模板
              </button>
            </div>
          ) : null}
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
                  if (window.confirm(`删除 ${provider} 的凭据？原文件会备份为 auth.json.bak-manager。`)) {
                    void onDelete()
                  }
                }}
              >
                删除条目
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
