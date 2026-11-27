import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import type {
  DiscoveryResult,
  GeneralListing,
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
import { ScopedModelsPanel } from './ScopedModelsPanel'

/**
 * 模型配置：pi 里所有模型相关配置的唯一入口，左列表三个固定项 + 自建 provider。
 *
 * - 默认模型：settings.json 的 defaultProvider/defaultModel + defaultThinkingLevel
 * - 启用模型：settings.json 的 enabledModels（ScopedModelsPanel，含模型目录刷新）
 * - 自建 provider：models.json 的 providers（发现、测试、逐个添加）
 *
 * 写回全部走 runWrite 乐观锁；草稿 JSON 是 provider 编辑的唯一真源。
 */

const DEFAULT_PANE = '__default__'
const ENABLED_PANE = '__enabled__'
const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function ModelsSection({ home }: { home: string }) {
  const [listing, setListing] = useState<ModelsListing | null>(null)
  const [general, setGeneral] = useState<GeneralListing | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(DEFAULT_PANE)
  const [creating, setCreating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const runWrite = useAppStore((s) => s.runWrite)
  const setFooter = useAppStore((s) => s.setFooter)

  const reload = useCallback(async () => {
    try {
      const [data, models, generalData] = await Promise.all([
        api.getModels(home),
        api.getModelCatalog(home),
        api.getGeneral(home),
      ])
      setListing(data)
      setGeneral(generalData)
      setCatalog(models)
      setError(null)
      setCreating(false)
      setSelected((current) =>
        current && (current === DEFAULT_PANE || current === ENABLED_PANE || data.providers.some((p) => p.name === current))
          ? current
          : DEFAULT_PANE,
      )
      return models
    } catch (err) {
      setError(describeError(err))
      return undefined
    }
  }, [home])

  // 运行时目录是 context / 输出上限的唯一来源：首次打开自动采集一次，
  // 之后只在用户点「刷新模型目录」时重新采集（它会加载扩展并访问网关）。
  const refreshCatalog = useCallback(async () => {
    setRefreshing(true)
    setFooter('busy', '采集模型目录…')
    try {
      const models = await api.refreshModelCatalog(home)
      setCatalog(models)
      setError(null)
      setFooter('ok', `模型目录已更新：${models.candidates.length} 个候选`)
    } catch (err) {
      setFooter('error', `采集模型目录失败：${describeError(err)}`)
    } finally {
      setRefreshing(false)
    }
  }, [home, setFooter])

  useEffect(() => {
    void reload().then((models) => {
      if (models && models.catalogFetchedAt === null) void refreshCatalog()
    })
  }, [reload, refreshCatalog])

  if (error) return <ErrorBanner message={error} />
  if (!listing || !general || !catalog) return <Loading />

  const selectedProvider = listing.providers.find((p) => p.name === selected) ?? null
  const catalogNote = `settings 启用 ${catalog.enabledModels.length} 条 · 自建 ${catalog.modelsJsonProviders.length} 个 · 运行目录 ${catalog.store.reduce((sum, item) => sum + item.modelCount, 0)} 个模型`

  async function saveOne(name: string, entry: Record<string, unknown> | null, label: string) {
    return runWrite(label, async () => {
      await api.putModelProviders(home, { [name]: entry }, listing!.revision)
      await reload()
    })
  }

  /** 写 models.json 的 modelOverrides（启用模型面板的行内 contextWindow/maxTokens）。 */
  async function saveOverride(
    overrideProvider: string,
    overrideModelId: string,
    override: Record<string, unknown> | null,
    label: string,
  ): Promise<boolean> {
    return runWrite(label, async () => {
      await api.putModelOverride(home, overrideProvider, overrideModelId, override, catalog!.modelsRevision)
      await reload()
    })
  }

  async function saveEnabled(next: string[] | null, label: string): Promise<boolean> {
    return runWrite(label, async () => {
      const result = await api.putGeneralKey(home, 'enabledModels', next, general!.revision)
      if (result.changed) await reload()
    })
  }

  const reloadThen = async () => {
    await reload()
  }

  return (
    <SectionSplit
      list={
        <>
          <SectionListHead
            title="模型配置"
            actions={
              <button type="button" className="btn small" onClick={() => setCreating(true)}>
                新增
              </button>
            }
          />
          <SectionListItem
            active={selected === DEFAULT_PANE && !creating}
            title="默认模型"
            sub={
              catalog.configured.provider && catalog.configured.modelId
                ? `${catalog.configured.provider}/${catalog.configured.modelId}`
                : '（未设置，pi 自动选）'
            }
            onClick={() => {
              setCreating(false)
              setSelected(DEFAULT_PANE)
            }}
          />
          <SectionListItem
            active={selected === ENABLED_PANE && !creating}
            title="启用模型"
            sub={`enabledModels · ${catalog.enabledModels.length} 条`}
            onClick={() => {
              setCreating(false)
              setSelected(ENABLED_PANE)
            }}
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
        ) : selected === DEFAULT_PANE ? (
          <DefaultModelPane home={home} general={general} catalog={catalog} onChanged={reloadThen} />
        ) : selected === ENABLED_PANE ? (
          <div className="detail-sheet is-plain">
            <SectionDetailHead
              title="启用模型（enabledModels）"
              meta="对齐 pi 的 /scoped-models：逐条开关、可排序、可加模式"
            />
            <ScopedModelsPanel
              catalog={catalog}
              onRefresh={async () => {
              await refreshCatalog()
            }}
              refreshing={refreshing}
              onSaveOverride={saveOverride}
              onSave={saveEnabled}
            />
          </div>
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
          <EmptyState title="没有选中的配置项" hint="在左侧选择默认模型、启用模型或一个 provider。" />
        )
      }
    />
  )
}

/** 默认模型 + 默认思考级别（settings.json 的 defaultProvider/defaultModel/defaultThinkingLevel）。 */
function DefaultModelPane({
  home,
  general,
  catalog,
  onChanged,
}: {
  home: string
  general: GeneralListing
  catalog: ModelCatalog
  onChanged: () => Promise<void>
}) {
  const runWrite = useAppStore((s) => s.runWrite)

  const provider = typeof general.managed.defaultProvider === 'string' ? general.managed.defaultProvider : ''
  const modelId = typeof general.managed.defaultModel === 'string' ? general.managed.defaultModel : ''
  // 未显式设置默认模型时，pi 会自动选启用清单里的第一个可解析模型；界面把
  // 这个生效值亮出来，避免「默认为空」看起来像配置丢了。
  const effectiveDefault =
    provider && modelId
      ? `${provider}/${modelId}`
      : (catalog.candidates.find((candidate) => candidate.enabled && !candidate.pattern)?.ref ?? '')
  const thinking = typeof general.managed.defaultThinkingLevel === 'string' ? general.managed.defaultThinkingLevel : ''

  async function writeModel(nextProvider: string, nextModelId: string) {
    await runWrite('保存默认模型', async () => {
      const result = await api.putGeneralModel(home, nextProvider, nextModelId, general.revision)
      if (result.changed) await onChanged()
    })
  }

  async function writeThinking(level: string) {
    await runWrite('保存思考级别', async () => {
      const result = await api.putGeneralKey(home, 'defaultThinkingLevel', level || null, general.revision)
      if (result.changed) await onChanged()
    })
  }

  return (
    <div className="detail-sheet is-plain">
      <SectionDetailHead
        title="默认模型"
        meta="settings.json 受管 key；留空时 pi 自动选第一个可解析的启用模型"
      />
      <div className="settings-form-narrow">
        <div className="stack">
          <Field
            label="默认模型"
            hint={
              provider && modelId
                ? 'defaultProvider + defaultModel 两个 key，留空表示交给 pi 自动选。'
                : `未显式设置，pi 自动选：${effectiveDefault || '（没有可解析的启用模型）'}`
            }
          >
            <div className="field-row">
              <input
                className="input"
                key={`${provider}/${modelId}`}
                defaultValue={effectiveDefault}
                placeholder="provider/modelId"
                list="model-catalog-refs"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const raw = (e.target as HTMLInputElement).value.trim()
                  if (raw === effectiveDefault) return
                  const [nextProvider, ...rest] = raw.split('/')
                  void writeModel(nextProvider ?? '', rest.join('/'))
                }}
                onBlur={(e) => {
                  const raw = e.target.value.trim()
                  // 展示的可能是 pi 自动选出的生效值；没改就不落盘，避免把自动选择固化为显式设置。
                  if (raw === effectiveDefault) return
                  const [nextProvider, ...rest] = raw.split('/')
                  void writeModel(raw ? (nextProvider ?? '') : '', raw ? rest.join('/') : '')
                }}
              />
              <datalist id="model-catalog-refs">
                {catalog.refs.map((ref) => (
                  <option key={ref} value={ref} />
                ))}
              </datalist>
            </div>
          </Field>

          <Field label="默认思考级别" hint="对应 defaultThinkingLevel；不同模型支持的级别不同，pi 会就近取值。">
            <select
              className="select"
              value={thinking}
              onChange={(e) => void writeThinking(e.target.value)}
            >
              {THINKING_LEVELS.map((level) => (
                <option key={level || 'unset'} value={level}>
                  {level === '' ? '（未设置）' : level}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="mono-dim">
          新会话的启动模型取启用清单第一条；模型不在选择器里出现时，先到「启用模型」里加一条，
          自建模型在左侧 provider 里配置。
        </p>
      </div>
    </div>
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
