import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { GeneralListing, ModelCatalog } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { ErrorBanner, Field, Loading } from '../ui'
import { ScopedModelsPanel } from './ScopedModelsPanel'

/**
 * 常规：settings.json 的受管 key（默认模型/启用模型/思考级别/默认工具/codemode）。
 * 形状与 pi 1.6 的 settings schema 一致：默认模型是 defaultProvider + defaultModel
 * 两个独立字符串，思考级别枚举来自 schema，codemode 只有 mode=on|only 加 inlineBudget。
 * 未知 key 只展示数量，不做编辑。
 */

const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const CODEMODE_MODES = ['', 'on', 'only'] as const

export function GeneralSection({ home }: { home: string }) {
  const [listing, setListing] = useState<GeneralListing | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const runWrite = useAppStore((s) => s.runWrite)
  const setFooter = useAppStore((s) => s.setFooter)

  const reload = useCallback(async () => {
    try {
      const [general, models] = await Promise.all([api.getGeneral(home), api.getModelCatalog(home)])
      setListing(general)
      setCatalog(models)
      setError(null)
      return models
    } catch (err) {
      setError(describeError(err))
      return null
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
  if (!listing || !catalog) return <Loading />

  const provider = typeof listing.managed.defaultProvider === 'string' ? listing.managed.defaultProvider : ''
  const modelId = typeof listing.managed.defaultModel === 'string' ? listing.managed.defaultModel : ''
  const thinking = typeof listing.managed.defaultThinkingLevel === 'string' ? listing.managed.defaultThinkingLevel : ''
  const defaultTools = Array.isArray(listing.managed.defaultTools)
    ? (listing.managed.defaultTools as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  const codemode = listing.managed.codemode as { mode?: unknown; inlineBudget?: unknown } | undefined
  const codemodeMode = typeof codemode?.mode === 'string' ? codemode.mode : ''
  const codemodeBudget = typeof codemode?.inlineBudget === 'number' ? String(codemode.inlineBudget) : ''

  async function writeKey(key: string, value: unknown, label: string) {
    await runWrite(label, async () => {
      const result = await api.putGeneralKey(home, key, value, listing!.revision)
      if (result.changed) await reload()
    })
  }

  async function writeModel(nextProvider: string, nextModelId: string) {
    await runWrite('保存默认模型', async () => {
      const result = await api.putGeneralModel(home, nextProvider, nextModelId, listing!.revision)
      if (result.changed) await reload()
    })
  }

  function writeCodemode(mode: string, budget: string) {
    if (!mode) return writeKey('codemode', null, '保存 codemode')
    const value: Record<string, unknown> = { mode }
    const parsed = Number(budget)
    if (budget && Number.isFinite(parsed) && parsed >= 0) value.inlineBudget = parsed
    return writeKey('codemode', value, '保存 codemode')
  }

  return (
    <section className="section">
      <header className="section-head">
        <h1 className="section-title">常规</h1>
        <span className="section-desc">settings.json 受管 key · 其余 {listing.unmanagedKeys.length} 个 key 不会改动</span>
      </header>
      <div className="settings-form-narrow">
        <div className="stack">
        <Field
          label="默认模型"
          hint={`defaultProvider + defaultModel 两个 key，如 ${catalog.configured.provider ?? 'sub2api-local'}/gpt-6.1-terra。留空表示交给 pi 自动选。`}
        >
          <div className="field-row">
            <input
              className="input"
              key={`${provider}/${modelId}`}
              defaultValue={provider && modelId ? `${provider}/${modelId}` : ''}
              placeholder="provider/modelId"
              list="model-catalog-refs"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const [nextProvider, ...rest] = (e.target as HTMLInputElement).value.trim().split('/')
                void writeModel(nextProvider ?? '', rest.join('/'))
              }}
              onBlur={(e) => {
                const raw = e.target.value.trim()
                if (raw === (provider && modelId ? `${provider}/${modelId}` : '')) return
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
            onChange={(e) =>
              void writeKey('defaultThinkingLevel', e.target.value || null, '保存思考级别')
            }
          >
            {THINKING_LEVELS.map((level) => (
              <option key={level || 'unset'} value={level}>
                {level === '' ? '（未设置）' : level}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="默认工具（defaultTools）"
          hint="逗号分隔的 +name / -name 修饰，例如 +codemode,-read。留空清除。"
        >
          <ToolListInput
            initial={defaultTools}
            onCommit={(next) =>
              void writeKey('defaultTools', next.length > 0 ? next : null, '保存默认工具')
            }
          />
        </Field>

        <Field
          label="codemode 模式"
          hint="on：保留直接工具并标注可从脚本调用的工具；only：所有脚本可调用工具都收进 codemode。"
        >
          <div className="field-row">
            <select
              className="select"
              value={codemodeMode}
              onChange={(e) => void writeCodemode(e.target.value, codemodeBudget)}
            >
              {CODEMODE_MODES.map((mode) => (
                <option key={mode || 'unset'} value={mode}>
                  {mode === '' ? '（未设置）' : mode}
                </option>
              ))}
            </select>
            <input
              className="input"
              key={`budget-${codemodeBudget}`}
              defaultValue={codemodeBudget}
              placeholder="inlineBudget（默认 3000）"
              onBlur={(e) => {
                const next = e.target.value.trim()
                if (next === codemodeBudget) return
                void writeCodemode(codemodeMode, next)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
          </div>
        </Field>
        </div>
        <p className="mono-dim">
          本页只覆盖 settings.json；凭据在「凭据」分区，插件条目在「插件」分区，
          自建 provider 在「自定义模型」分区，内置 subagent 开关在「Subagent」分区。
        </p>
      </div>

      <div className="section-body">
        <div className="section-head-inline">
          <h2 className="section-caption">启用模型（enabledModels）</h2>
          <span className="mono-dim">对齐 pi 的 /scoped-models：逐条开关、可排序、可加模式</span>
        </div>
        <ScopedModelsPanel
          catalog={catalog}
          onRefresh={refreshCatalog}
          refreshing={refreshing}
          onSave={(next, label) =>
            runWrite(label, async () => {
              const result = await api.putGeneralKey(home, 'enabledModels', next, listing!.revision)
              if (result.changed) await reload()
            })
          }
        />
      </div>
    </section>
  )
}

function ToolListInput({
  initial,
  onCommit,
}: {
  initial: string[]
  onCommit: (next: string[]) => void
}) {
  const [text, setText] = useState(initial.join(', '))
  return (
    <div className="field-row">
      <input
        className="input"
        value={text}
        placeholder="+codemode, -read"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = text
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          if (JSON.stringify(next) !== JSON.stringify(initial)) onCommit(next)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}
