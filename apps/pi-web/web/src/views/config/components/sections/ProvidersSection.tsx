import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AuthEntryView, AuthListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { SectionDetailHead, SectionFooterNote, SectionListHead, SectionListItem, SectionSplit } from '../layout'
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
    <SectionSplit
      list={
        <>
          <SectionListHead
            title="凭据"
            actions={
              <button type="button" className="btn small" onClick={() => setCreating(true)}>
                新增
              </button>
            }
          />
          {listing.entries.map((entry) => (
            <SectionListItem
              key={entry.provider}
              active={entry.provider === selected && !creating}
              data-mark={entry.maskedFields.length > 0 || entry.keyCommand ? 'ok' : 'warn'}
              title={entry.provider}
              sub={entry.keyCommand
                ? '从命令取密钥'
                : entry.maskedFields.length > 0
                  ? `掩码字段：${entry.maskedFields.join('、')}`
                  : '（无凭据字段）'}
              badges={<span className="badge">{TYPE_LABEL[entry.type]}</span>}
              onClick={() => {
                setCreating(false)
                setSelected(entry.provider)
              }}
            />
          ))}
          {listing.entries.length === 0 ? (
            <p className="mono-dim">auth.json 里还没有凭据。</p>
          ) : null}
        </>
      }
      footer={
        <SectionFooterNote note="凭据原文不会回传到页面；环境变量提供的密钥不写进 auth.json，本页看不到。" />
      }
      detail={
        creating ? (
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
      ) : (
        <EmptyState title="没有选中的凭据" hint="在左侧选择一个条目，或点「新增」。" />
      )}
    />
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
    <div className="detail-sheet is-plain">
      <SectionDetailHead
        title={isNew ? '新增条目' : provider}
        meta="key / access / refresh 显示为掩码时，原样保存即保留原文；改成新值则写新值"
      />
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
  )
}
