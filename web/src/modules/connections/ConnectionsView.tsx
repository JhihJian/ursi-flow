import { useCallback, useMemo, useState } from 'react'

import { api, errorMessage } from '@/shared/api'
import type { Connection } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { useUnsavedChanges } from '@/shared/hooks/use-unsaved-changes'
import { confirmAction, notify } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'

interface TestResult { ok: boolean; message: string; latency?: number }

const PROVIDERS = ['openai', 'anthropic', 'deepseek', 'ollama', 'custom']

function emptyConnection(): Connection {
  return { id: '', name: '', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', credentialRef: '', updatedAt: '' }
}

/** 模型连接：介绍面板、卡片网格、创建/编辑弹窗与模拟连接验证。 */
export default function ConnectionsView() {
  const { data: connections, loading, error, reload } = useResource((signal) => api.get<Connection[]>('/connections', signal), [])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Connection | null>(null)
  const [baseline, setBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [actionError, setActionError] = useState('')
  const [deleting, setDeleting] = useState('')
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [overlay, setOverlay] = useState<{ removed: string[]; changed: Connection[] }>({ removed: [], changed: [] })

  const list = useMemo(() => {
    const removed = new Set(overlay.removed)
    const changed = new Map(overlay.changed.map((item) => [item.id, item]))
    const base = connections.filter((item) => !removed.has(item.id)).map((item) => changed.get(item.id) ?? item)
    const known = new Set(base.map((item) => item.id))
    return [...base, ...overlay.changed.filter((item) => !known.has(item.id))]
  }, [connections, overlay])

  const dirty = draft !== null && JSON.stringify(draft) !== baseline
  const { canLeave } = useUnsavedChanges(() => dirty)

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return list
    return list.filter((item) => `${item.name} ${item.provider} ${item.model} ${item.baseUrl}`.toLowerCase().includes(keyword))
  }, [list, query])

  const providers = useMemo(() => new Set(list.map((item) => item.provider)).size, [list])

  const openEditor = useCallback((connection?: Connection) => {
    const next = connection ? { ...connection } : emptyConnection()
    setDraft(next)
    setBaseline(JSON.stringify(next))
    setFormError('')
  }, [])

  const closeEditor = useCallback(async () => {
    if (saving) return
    if (!await canLeave()) return
    setDraft(null)
  }, [canLeave, saving])

  const updateDraft = useCallback((patch: Partial<Connection>) => {
    setDraft((current) => current ? { ...current, ...patch } : current)
  }, [])

  const save = useCallback(async () => {
    if (!draft || saving) return
    setFormError('')
    const payload = {
      ...draft,
      name: draft.name.trim(),
      provider: draft.provider.trim(),
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      credentialRef: draft.credentialRef.trim(),
    }
    if (!payload.name || !payload.provider || !payload.model) {
      setFormError('请填写连接名称、服务提供方和模型名称。')
      return
    }
    try {
      const url = new URL(payload.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    } catch {
      setFormError('请填写有效的 HTTP(S) 服务地址，地址中不能包含账号、密码、查询参数或片段。')
      return
    }
    setSaving(true)
    try {
      const saved = payload.id
        ? await api.put<Connection>(`/connections/${encodeURIComponent(payload.id)}`, payload)
        : await api.post<Connection>('/connections', payload)
      setOverlay((current) => ({
        ...current,
        changed: current.changed.some((item) => item.id === saved.id)
          ? current.changed.map((item) => item.id === saved.id ? saved : item)
          : [...current.changed, saved],
      }))
      setResults((current) => {
        const next = { ...current }
        delete next[saved.id]
        return next
      })
      setDraft(null)
      notify(payload.id ? '连接配置已保存' : '连接已创建')
    } catch (cause) {
      setFormError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }, [draft, saving])

  const test = useCallback(async (connection: Connection) => {
    if (testing[connection.id]) return
    setTesting((current) => ({ ...current, [connection.id]: true }))
    setResults((current) => {
      const next = { ...current }
      delete next[connection.id]
      return next
    })
    try {
      const result = await api.post<TestResult>(`/connections/${encodeURIComponent(connection.id)}/test`)
      setResults((current) => ({ ...current, [connection.id]: result }))
    } catch (cause) {
      setResults((current) => ({ ...current, [connection.id]: { ok: false, message: errorMessage(cause) } }))
    } finally {
      setTesting((current) => {
        const next = { ...current }
        delete next[connection.id]
        return next
      })
    }
  }, [testing])

  const remove = useCallback(async (connection: Connection) => {
    if (deleting) return
    const accepted = await confirmAction({
      title: `删除「${connection.name}」？`,
      description: '删除后无法恢复。被角色引用的连接需要先解除引用。',
      danger: true,
      confirmLabel: '删除连接',
    })
    if (!accepted) return
    setDeleting(connection.id)
    setActionError('')
    try {
      await api.delete(`/connections/${encodeURIComponent(connection.id)}`)
      setOverlay((current) => ({ ...current, removed: [...current.removed, connection.id] }))
      setResults((current) => {
        const next = { ...current }
        delete next[connection.id]
        return next
      })
      notify('连接已删除')
    } catch (cause) {
      const message = errorMessage(cause)
      setActionError(message)
      notify(message, 'error')
    } finally {
      setDeleting('')
    }
  }, [deleting])

  return (
    <div className="page-stack min-w-0">
      <PageHeader
        title="模型连接"
        description="统一管理模型服务，让每个角色连接合适的智能。"
        icon="connector"
        actions={<Button variant="primary" icon="plus" onClick={() => { openEditor() }}>新建连接</Button>}
      />

      <div className="panel flex items-center gap-[18px] p-6 max-[600px]:flex-wrap max-[600px]:gap-3 max-[600px]:p-[18px]">
        <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[15px] bg-accent/10 text-accent">
          <Icon name="connector" size={25} />
        </span>
        <div className="min-w-0 flex-1 max-[600px]:basis-[calc(100%-64px)]">
          <h2 className="m-0 mb-1.5 text-[15px] font-semibold text-txt">模型服务，集中配置</h2>
          <p className="m-0 text-xs leading-[1.8] text-txt3">角色通过连接引用模型。凭据仅保存引用标识，由执行环境解析。</p>
        </div>
        <div className="flex min-w-[72px] flex-col items-center gap-1 max-[600px]:flex-1 max-[600px]:items-start max-[600px]:pl-1">
          <strong className="text-2xl font-semibold text-txt">{list.length}</strong>
          <span className="text-xs text-txt3">模型连接</span>
        </div>
        <div className="flex min-w-[72px] flex-col items-center gap-1 max-[600px]:flex-1 max-[600px]:items-start max-[600px]:pl-1">
          <strong className="text-2xl font-semibold text-txt">{providers}</strong>
          <span className="text-xs text-txt3">服务提供方</span>
        </div>
      </div>

      <div className="toolbar">
        <div className="search-input max-w-[420px] min-w-[180px] flex-1">
          <Icon name="search" size={16} />
          <input value={query} onChange={(event) => { setQuery(event.target.value) }} aria-label="搜索连接" placeholder="搜索名称、模型或服务地址…" />
        </div>
        <span className="ml-auto text-xs text-txt3">{filtered.length} 个连接</span>
        <Button variant="ghost" size="sm" icon="refresh" disabled={loading} onClick={reload}>刷新</Button>
      </div>

      {actionError ? (
        <p role="alert" className="rounded-lg bg-err/10 px-3.5 py-3 text-xs text-err [overflow-wrap:anywhere]">{actionError}</p>
      ) : null}

      {loading || error ? (
        <ResourceState loading={loading} error={error} onRetry={reload} />
      ) : !list.length ? (
        <div className="panel">
          <ResourceState empty title="连接你的第一个模型" description="添加服务地址与凭据引用，即可在角色工作室中选择。" />
          <div className="flex justify-center px-5 pb-7">
            <Button icon="plus" onClick={() => { openEditor() }}>新建连接</Button>
          </div>
        </div>
      ) : !filtered.length ? (
        <div className="panel">
          <ResourceState empty title="没有匹配的连接" description="试试其他名称、服务提供方或模型关键词。" />
          <div className="flex justify-center px-5 pb-7">
            <Button variant="outline" onClick={() => { setQuery('') }}>清空搜索</Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,360px),1fr))] gap-4">
          {filtered.map((connection) => {
            const result = results[connection.id]
            const busy = Boolean(testing[connection.id]) || deleting === connection.id
            return (
              <article key={connection.id} className="panel flex min-w-0 flex-col p-[18px] transition-shadow hover:shadow-[0_5px_24px_rgb(0_0_0/0.04)] min-[600px]:p-[22px]">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-elevated text-[13px] font-bold text-accent">
                    {connection.provider.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="m-0 text-sm font-semibold text-txt [overflow-wrap:anywhere]">{connection.name}</h2>
                    <span className="text-[11px] text-txt3">{connection.provider}</span>
                  </div>
                  <span className="whitespace-nowrap rounded-[5px] border border-line px-[7px] py-[3px] text-[10px] text-txt3">已配置</span>
                </div>

                <dl className="m-0 flex flex-1 flex-col gap-3.5 py-6">
                  <div className="grid grid-cols-[65px_minmax(0,1fr)] gap-2 text-xs">
                    <dt className="text-txt3">模型</dt>
                    <dd className="m-0 flex min-w-0 items-baseline gap-1.5 text-txt [overflow-wrap:anywhere]">
                      <Icon name="brain" size={14} className="shrink-0" />
                      {connection.model}
                    </dd>
                  </div>
                  <div className="grid grid-cols-[65px_minmax(0,1fr)] gap-2 text-xs">
                    <dt className="text-txt3">服务地址</dt>
                    <dd className="m-0 min-w-0 break-words font-mono text-[11px] text-txt2 [overflow-wrap:anywhere]">{connection.baseUrl}</dd>
                  </div>
                  <div className="grid grid-cols-[65px_minmax(0,1fr)] gap-2 text-xs">
                    <dt className="text-txt3">凭据引用</dt>
                    <dd className="m-0 flex min-w-0 items-baseline gap-1.5 text-txt2 [overflow-wrap:anywhere]">
                      <Icon name="lock" size={13} className="shrink-0" />
                      {connection.credentialRef || '未设置'}
                    </dd>
                  </div>
                </dl>

                {result ? (
                  <div
                    role="status"
                    className={`mb-4 flex flex-col gap-[5px] rounded-lg px-3 py-3 text-[11px] [overflow-wrap:anywhere] ${result.ok ? 'bg-ok/10 text-ok' : 'bg-err/10 text-err'}`}
                  >
                    <strong>模拟连接验证 · {result.ok ? '通过' : '未通过'}</strong>
                    <span>{result.message}</span>
                    {result.latency !== undefined ? <span>模拟耗时 {result.latency} ms</span> : null}
                  </div>
                ) : null}

                <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-3.5">
                  <Button variant="outline" size="sm" icon="play" loading={Boolean(testing[connection.id])} disabled={deleting === connection.id} onClick={() => { void test(connection) }}>模拟验证</Button>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" icon="edit" disabled={busy} onClick={() => { openEditor(connection) }}>编辑</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      aria-label={`删除 ${connection.name}`}
                      loading={deleting === connection.id}
                      disabled={Boolean(deleting) || Boolean(testing[connection.id])}
                      onClick={() => { void remove(connection) }}
                    />
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <p className="flex items-center gap-2 text-[11px] leading-[1.8] text-txt3">
        <Icon name="info" size={14} className="shrink-0" />
        模拟连接验证用于检查演示配置，不代表真实模型认证或网络连通性。
      </p>

      <Modal
        open={Boolean(draft)}
        title={draft?.id ? '编辑模型连接' : '新建模型连接'}
        width={600}
        onClose={() => { void closeEditor() }}
        footer={(
          <>
            {dirty ? <span className="mr-auto text-[11px] text-warn">未保存的更改</span> : null}
            <Button variant="outline" disabled={saving} onClick={() => { void closeEditor() }}>取消</Button>
            <Button variant="primary" type="submit" form="connection-form" loading={saving} icon="check">
              {draft?.id ? '保存连接' : '创建连接'}
            </Button>
          </>
        )}
      >
        {draft ? (
          <form id="connection-form" className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void save() }}>
            <p className="m-0 mb-[22px] text-xs text-txt3">设置模型的访问方式，供角色统一引用。</p>
            {formError ? <p role="alert" className="m-0 rounded-lg bg-err/10 px-3.5 py-3 text-xs text-err [overflow-wrap:anywhere]">{formError}</p> : null}
            <fieldset className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0" disabled={saving}>
              <label className="field">
                <span className="field-label">连接名称 <span className="text-err">*</span></span>
                <Input required maxLength={100} value={draft.name} onChange={(event) => { updateDraft({ name: event.target.value }) }} placeholder="例如：团队主力模型" />
              </label>
              <div className="grid grid-cols-1 gap-4 min-[600px]:grid-cols-2">
                <label className="field">
                  <span className="field-label">服务提供方 <span className="text-err">*</span></span>
                  <Input required list="connection-providers" value={draft.provider} onChange={(event) => { updateDraft({ provider: event.target.value }) }} placeholder="openai" />
                  <datalist id="connection-providers">
                    {PROVIDERS.map((provider) => <option key={provider} value={provider} />)}
                  </datalist>
                </label>
                <label className="field">
                  <span className="field-label">模型名称 <span className="text-err">*</span></span>
                  <Input required value={draft.model} onChange={(event) => { updateDraft({ model: event.target.value }) }} placeholder="例如：gpt-4.1" />
                </label>
              </div>
              <label className="field">
                <span className="field-label">服务地址 <span className="text-err">*</span></span>
                <Input className="font-mono" type="url" required value={draft.baseUrl} onChange={(event) => { updateDraft({ baseUrl: event.target.value }) }} placeholder="https://api.example.com/v1" />
                <span className="text-[11px] leading-[1.7] text-txt3">填写 HTTP(S) 基础地址，不含认证信息与查询参数。</span>
              </label>
              <label className="field">
                <span className="field-label">凭据引用</span>
                <Input className="font-mono" autoComplete="off" value={draft.credentialRef} onChange={(event) => { updateDraft({ credentialRef: event.target.value }) }} placeholder="例如：env:OPENAI_API_KEY" />
                <span className="text-[11px] leading-[1.7] text-txt3">只填写凭据标识，不要输入 API Key 或其他密钥。</span>
              </label>
            </fieldset>
          </form>
        ) : null}
      </Modal>
    </div>
  )
}
