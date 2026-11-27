import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import type {
  DiscoveryResult,
  ModelCatalog,
  ModelsListing,
  ProbeResult,
  ProviderView,
} from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { SectionDetailHead, SectionFooterNote, SectionListHead, SectionListItem, SectionSplit } from '../layout'
import { EmptyState, ErrorBanner, Field, Loading } from '../ui'
import {
  appendModelToEntry,
  diffDiscovered,
  filterModels,
  modelIdOf,
  modelsOf,
  removeModelFromEntry,
  type DraftModel,
} from './models-discover-helpers'

/**
 * 自定义模型（models.json）：provider 列表 + JSON 详情编辑，split view 结构。
 * 合并写回语义：保存时只提交当前编辑的条目（其余原样保留），条目置 null 删除。
 * apiKey 以掩码回显，原样提交会被服务端还原成原文；改成新值就写新值。
 * 发现模型：拉取后是可浏览列表，逐个添加进草稿，保存才落盘。
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

  const catalogNote = `settings 启用 ${catalog.enabledModels.length} 条 · 自建 ${catalog.modelsJsonProviders.length} 个 · 运行目录 ${catalog.store.reduce((sum, item) => sum + item.modelCount, 0)} 个模型`

  return (
    <SectionSplit
      list={
        <>
          <SectionListHead
            title="自定义模型"
            actions={
              <button type="button" className="btn small" onClick={() => setCreating(true)}>
                新增
              </button>
            }
          />
          {listing.providers.map((provider) => (
            <SectionListItem
              key={provider.name}
              active={provider.name === selected && !creating}
              data-mark={provider.hasApiKey ? 'ok' : 'off'}
              title={provider.name}
              sub={provider.baseUrl || '（无 baseUrl）'}
              badges={<span className="badge">{provider.modelCount}</span>}
              onClick={() => {
                setCreating(false)
                setSelected(provider.name)
              }}
            />
          ))}
          {listing.providers.length === 0 ? (
            <p className="mono-dim">
              models.json 没有自建 provider。本机的 provider 可能由扩展注册，扩展不写入 models.json。
            </p>
          ) : null}
        </>
      }
      footer={
        <SectionFooterNote
          note={listing.hadComments ? '文件含注释，保存写回纯 JSON 会丢注释（备份 .bak-manager）' : catalogNote}
        />
      }
      detail={
        creating ? (
          <ProviderEditor
            key="__new__"
            home={home}
            provider={{ name: '', baseUrl: '', apiKeyMasked: null, hasApiKey: false, modelCount: 0, entry: { baseUrl: '', models: [] } }}
            isNew
            onSave={(name, entry) => saveOne(name, entry, `新增 provider ${name}`)}
            onCancel={() => setCreating(false)}
          />
        ) : selectedProvider ? (
          <ProviderEditor
            key={selectedProvider.name}
            home={home}
            provider={selectedProvider}
            isNew={false}
            onSave={(name, entry) => saveOne(name, entry, `保存 provider ${name}`)}
            onDelete={() => saveOne(selectedProvider.name, null, `删除 provider ${selectedProvider.name}`)}
          />
        ) : (
          <EmptyState title="没有选中的 provider" hint="在左侧选择一个 provider，或点「新增」。" />
        )
      }
    />
  )
}

function modelCapabilities(model: DraftModel): string {
  const capabilities = [
    model.reasoning === true ? '思考' : null,
    Array.isArray(model.input) && model.input.includes('image') ? '图片' : null,
  ].filter(Boolean)
  return capabilities.length > 0 ? capabilities.join(' / ') : '—'
}

function ProviderEditor({
  home,
  provider,
  isNew,
  onSave,
  onDelete,
  onCancel,
}: {
  home: string
  provider: ProviderView
  isNew: boolean
  onSave: (name: string, entry: Record<string, unknown>) => Promise<boolean>
  onDelete?: () => Promise<boolean>
  onCancel?: () => void
}) {
  const [name, setName] = useState(provider.name)
  const [text, setText] = useState(() => JSON.stringify(provider.entry, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [testModelId, setTestModelId] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProbeResult | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveryResult | null>(null)
  const [discoverQuery, setDiscoverQuery] = useState('')
  const nameValid = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)

  const models = useMemo(() => modelsOfDraft(text), [text])
  const diff = useMemo(
    () => (discovered ? diffDiscovered(discovered.models as unknown as DraftModel[], models) : null),
    [discovered, models],
  )
  const shownDiscovered = useMemo(
    () => (discovered ? filterModels(discovered.models as unknown as DraftModel[], discoverQuery) : []),
    [discovered, discoverQuery],
  )

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

  async function runTest() {
    const entry = parseDraft()
    if (!entry || !nameValid) return
    const modelId = testModelId.trim() || models[0]?.id
    const model = models.find((item) => modelIdOf(item) === modelId) ?? { id: modelId }
    if (typeof model.id !== 'string' || !model.id) {
      setTestResult({ ok: false, error: '先填一个模型 id' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await api.testModel(home, name, entry, model as Record<string, unknown>))
    } catch (err) {
      setTestResult({ ok: false, error: describeError(err) })
    } finally {
      setTesting(false)
    }
  }

  async function runDiscover() {
    const entry = parseDraft()
    if (!entry || !nameValid) return
    setDiscovering(true)
    setDiscovered(null)
    try {
      setDiscovered(await api.discoverModels(home, name, entry))
    } catch (err) {
      setDiscovered({ models: [], endpoint: describeError(err) })
    } finally {
      setDiscovering(false)
    }
  }

  /** 把一个发现模型追加进草稿；草稿变驱动 diff 重算，该行自动翻成「已存在」。 */
  function addOne(model: DraftModel) {
    const entry = parseDraft()
    if (!entry) return
    setText(JSON.stringify(appendModelToEntry(entry, model), null, 2))
  }

  function addAllMissing() {
    if (!diff || diff.missing.length === 0) return
    const entry = parseDraft()
    if (!entry) return
    const next = diff.missing.reduce((acc, model) => appendModelToEntry(acc, model), entry)
    setText(JSON.stringify(next, null, 2))
  }

  function removeModel(index: number) {
    const entry = parseDraft()
    if (!entry) return
    setText(JSON.stringify(removeModelFromEntry(entry, index), null, 2))
  }

  return (
    <div className="detail-sheet is-plain">
      <SectionDetailHead
        title={isNew ? '新增 provider' : provider.name}
        meta="apiKey 显示为掩码时，原样保存即保留原值；改成新值则写新值。"
      />
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

        <Field label="条目 JSON" hint="pi 的 provider 条目：baseUrl / api / apiKey / headers / models / modelOverrides。">
          <textarea
            className="textarea code"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          {jsonError ? <span className="field-hint">{jsonError}</span> : null}
        </Field>

        <div className="detail-block">
          <div className="section-head-inline">
            <span className="field-label">模型</span>
            <span className="mono-dim">{models.length} 个 · 对齐 pi --list-models 的列</span>
          </div>
          <ModelRows models={models} onRemove={removeModel} />
        </div>

        <div className="detail-grid">
          <Field label="测试连接" hint="用当前草稿与该 home 的 auth.json 发一次真实请求（16 token，20s 超时）。">
            <div className="field-row">
              <input
                className="input"
                value={testModelId}
                list="provider-model-ids"
                placeholder={models[0]?.id ? String(models[0].id) : 'model id'}
                onChange={(e) => setTestModelId(e.target.value)}
              />
              <datalist id="provider-model-ids">
                {models.map((model) => (
                  <option key={modelIdOf(model)} value={modelIdOf(model)} />
                ))}
              </datalist>
              <button type="button" className="btn small" disabled={testing} onClick={() => void runTest()}>
                {testing ? '测试中…' : '测试'}
              </button>
            </div>
            {testResult ? (
              <span className={`field-hint${testResult.ok ? '' : ' error-text'}`}>
                {testResult.ok
                  ? `连接成功：${testResult.latencyMs ?? 0}ms${testResult.status ? ` · HTTP ${testResult.status}` : ''}${testResult.responseText ? ` · ${testResult.responseText}` : ''}`
                  : `测试失败：${testResult.error ?? '未知错误'}`}
              </span>
            ) : null}
          </Field>
        </div>

        <div className="detail-block">
          <div className="section-head-inline">
            <span className="field-label">发现模型</span>
            <button type="button" className="btn small" disabled={discovering} onClick={() => void runDiscover()}>
              {discovering ? '请求中…' : '从上游拉取'}
            </button>
          </div>
          <p className="field-hint">请求上游 /models（只读，不改文件）；在下方列表逐个添加，保存才落盘。</p>
          {discovered ? (
            discovered.models.length > 0 ? (
              <>
                <div className="field-row">
                  <input
                    className="input"
                    value={discoverQuery}
                    placeholder="按 id 或名称过滤"
                    onChange={(e) => setDiscoverQuery(e.target.value)}
                  />
                  {diff && diff.missing.length > 0 ? (
                    <button type="button" className="btn small" onClick={addAllMissing}>
                      添加全部缺失（{diff.missing.length}）
                    </button>
                  ) : null}
                </div>
                <div className="discover-scroll">
                  <table className="item-table model-table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th className="col-size">Context</th>
                        <th className="col-size">Max out</th>
                        <th className="col-size">能力</th>
                        <th className="col-state" />
                      </tr>
                    </thead>
                    <tbody>
                      {shownDiscovered.map((model) => {
                        const id = modelIdOf(model)
                        const exists = !id || (diff?.existingIds.has(id) ?? false)
                        return (
                          <tr key={id || Math.random().toString(36).slice(2)} title={typeof model.baseUrl === 'string' ? model.baseUrl : undefined}>
                            <td>
                              <div className="cell-title">{id || '（缺 id，手动补后可加）'}</div>
                              <div className="cell-sub">{typeof model.name === 'string' ? model.name : '—'}</div>
                            </td>
                            <td className="col-size">{typeof model.contextWindow === 'number' ? model.contextWindow.toLocaleString('en-US') : '—'}</td>
                            <td className="col-size">{typeof model.maxTokens === 'number' ? model.maxTokens.toLocaleString('en-US') : '—'}</td>
                            <td className="col-size">{modelCapabilities(model)}</td>
                            <td className="col-state">
                              {exists ? (
                                <span className="badge">已存在</span>
                              ) : (
                                <button type="button" className="btn small" onClick={() => addOne(model)}>
                                  添加
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <span className="field-hint mono-dim">{discovered.endpoint} · 拉取到 {discovered.models.length} 个模型</span>
              </>
            ) : (
              <p className="field-hint error-text">{discovered.endpoint || '（没有模型）'}</p>
            )
          ) : null}
        </div>

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
  )
}

function modelsOfDraft(text: string): DraftModel[] {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? modelsOf(parsed as Record<string, unknown>)
      : []
  } catch {
    return []
  }
}

function ModelRows({ models, onRemove }: { models: DraftModel[]; onRemove?: (index: number) => void }) {
  if (models.length === 0) return <p className="mono-dim">该 provider 还没有模型。</p>
  return (
    <table className="item-table model-table">
      <thead>
        <tr>
          <th>Model</th>
          <th className="col-size">Context</th>
          <th className="col-size">Max out</th>
          <th className="col-size">能力</th>
          {onRemove ? <th className="col-state" /> : null}
        </tr>
      </thead>
      <tbody>
        {models.map((model, index) => (
          <tr key={`${modelIdOf(model)}-${index}`} title={typeof model.baseUrl === 'string' ? model.baseUrl : undefined}>
            <td>
              <div className="cell-title">{modelIdOf(model) || '（缺 id）'}</div>
              <div className="cell-sub">{typeof model.name === 'string' ? model.name : '—'}</div>
            </td>
            <td className="col-size">{typeof model.contextWindow === 'number' ? model.contextWindow.toLocaleString('en-US') : '—'}</td>
            <td className="col-size">{typeof model.maxTokens === 'number' ? model.maxTokens.toLocaleString('en-US') : '—'}</td>
            <td className="col-size">{modelCapabilities(model)}</td>
            {onRemove ? (
              <td className="col-state">
                <button
                  type="button"
                  className="btn small btn-danger"
                  title={`从草稿移除 ${modelIdOf(model) || '该模型'}`}
                  onClick={() => {
                    if (window.confirm(`从草稿移除模型 ${modelIdOf(model) || '（缺 id）'}？`)) onRemove(index)
                  }}
                >
                  删除
                </button>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
