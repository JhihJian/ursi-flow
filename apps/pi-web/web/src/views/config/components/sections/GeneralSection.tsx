import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { GeneralListing, ModelCatalog } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { ErrorBanner, Field, Loading, Switch } from '../ui'
import { SectionDetailHead, SectionFooterNote, SectionListHead, SectionListItem, SectionSplit } from '../layout'
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
  const [toolsBusy, setToolsBusy] = useState(false)
  // 分区内二选一：常规设置 / 启用模型（enabledModels 面板体量大，单独成页）。
  const [pane, setPane] = useState<'settings' | 'enabled'>('settings')
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
  // 未显式设置默认模型时，pi 会自动选启用清单里的第一个可解析模型；界面把
  // 这个生效值亮出来，避免「默认为空」看起来像配置丢了。
  const effectiveDefault =
    provider && modelId
      ? `${provider}/${modelId}`
      : (catalog.candidates.find((candidate) => candidate.enabled && !candidate.pattern)?.ref ?? '')
  const thinking = typeof listing.managed.defaultThinkingLevel === 'string' ? listing.managed.defaultThinkingLevel : ''
  const defaultTools = Array.isArray(listing.managed.defaultTools)
    ? (listing.managed.defaultTools as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  const codemode = listing.managed.codemode as { mode?: unknown; inlineBudget?: unknown } | undefined
  const codemodeMode = typeof codemode?.mode === 'string' ? codemode.mode : ''
  const codemodeBudget = typeof codemode?.inlineBudget === 'number' ? String(codemode.inlineBudget) : ''
  const cacheMissNotices = listing.managed.showCacheMissNotices === true

  async function writeKey(key: string, value: unknown, label: string) {
    await runWrite(label, async () => {
      const result = await api.putGeneralKey(home, key, value, listing!.revision)
      if (result.changed) await reload()
    })
  }

  /**
   * 写 models.json 的 modelOverrides：pi 只支持在这里改内置或扩展提供模型的
   * contextWindow / maxTokens，不会被扩展注册的 provider 覆盖掉。
   */
  async function saveOverride(
    overrideProvider: string,
    overrideModelId: string,
    override: Record<string, unknown> | null,
    label: string,
  ): Promise<boolean> {
    const ok = await runWrite(label, async () => {
      await api.putModelOverride(home, overrideProvider, overrideModelId, override, catalog!.modelsRevision)
      await reload()
    })
    return ok
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

  /** 内置工具开关：服务端按 pi 的 +/- 修饰语义写回，等于默认组合时删除 key。 */
  async function writeBuiltinTools(next: string[]) {
    // 连点开关会让第二次请求带旧 revision：写入期间禁用开关，完成后按新状态重绘。
    setToolsBusy(true)
    await runWrite(`保存内置工具（已选 ${next.length} 个）`, async () => {
      const result = await api.putGeneralTools(home, next, listing!.revision)
      if (result.changed) await reload()
    })
    setToolsBusy(false)
  }

  function toggleBuiltinTool(name: string, enabled: boolean) {
    const current = listing!.builtinTools
    const next = enabled ? [...current, name] : current.filter((item) => item !== name)
    void writeBuiltinTools(next)
  }

  return (
    <SectionSplit
      list={
        <>
          <SectionListHead title="常规" />
          <SectionListItem
            active={pane === 'settings'}
            data-mark={undefined}
            title="常规设置"
            sub="默认模型、思考级别、工具、codemode"
            onClick={() => setPane('settings')}
          />
          <SectionListItem
            active={pane === 'enabled'}
            data-mark={undefined}
            title="启用模型"
            sub={`enabledModels · ${catalog.enabledModels.length} 条`}
            onClick={() => setPane('enabled')}
          />
        </>
      }
      footer={
        <SectionFooterNote
          note={`settings.json 受管 key · 其余 ${listing.unmanagedKeys.length} 个 key 不会改动`}
        />
      }
      detail={
        pane === 'settings' ? (
          <div className="detail-sheet is-plain">
            <SectionDetailHead
              title="常规设置"
              meta="settings.json 受管 key；默认模型留空时 pi 自动选第一个可解析的启用模型"
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
          label="内置工具"
          hint="defaultTools 解析出的实际工具集；与 pi / settings 的 +name / -name 语义一致，默认组合会删除该 key。"
        >
          <div className="tool-switches">
            {listing.builtinToolNames.map((name) => (
              <label key={name} className="tool-switch">
                <input
                  type="checkbox"
                  checked={listing.builtinTools.includes(name)}
                  disabled={toolsBusy}
                  onChange={(e) => toggleBuiltinTool(name, e.target.checked)}
                />
                <span>{name}</span>
              </label>
            ))}
          </div>
        </Field>

        {listing.isWindows ? (
          <Field label="Shell 工具" hint="PowerShell 打开时用 powershell 代替 bash。">
            <Switch
              pressed={listing.powerShellEnabled}
              label={listing.powerShellEnabled ? '使用 powershell' : '使用 bash'}
              onChange={(next) =>
                void runWrite('切换 Shell 工具', async () => {
                  await api.putGeneralShell(home, next, listing!.revision)
                  await reload()
                })
              }
            />
          </Field>
        ) : null}

        <Field
          label="默认工具（defaultTools）"
          hint={`已解析工具集：${listing.resolvedTools.join(', ') || '（空）'}。这里直接编辑 +name / -name 原文，留空清除。`}
        >
          <ToolListInput
            key={defaultTools.join(',')}
            initial={defaultTools}
            onCommit={(next) =>
              void writeKey('defaultTools', next.length > 0 ? next : null, '保存默认工具')
            }
          />
        </Field>

        <Field
          label="缓存未命中提示"
          hint="showCacheMissNotices：会话里显示 provider 缓存未命中的提示，写入 settings.json。"
        >
          <Switch
            pressed={cacheMissNotices}
            label={cacheMissNotices ? '已开启' : '已关闭'}
            onChange={(next) =>
              void writeKey('showCacheMissNotices', next ? true : null, '保存缓存未命中提示')
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
          </div>
        ) : (
          <div className="detail-sheet is-plain">
            <SectionDetailHead
              title="启用模型（enabledModels）"
              meta="对齐 pi 的 /scoped-models：逐条开关、可排序、可加模式"
            />
            <ScopedModelsPanel
              catalog={catalog}
              onRefresh={refreshCatalog}
              refreshing={refreshing}
              onSaveOverride={saveOverride}
              onSave={(next, label) =>
                runWrite(label, async () => {
                  const result = await api.putGeneralKey(home, 'enabledModels', next, listing!.revision)
                  if (result.changed) await reload()
                })
              }
            />
          </div>
        )
      }
    />
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
