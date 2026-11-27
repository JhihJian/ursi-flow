import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { GeneralListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { SectionDetailHead } from '../layout'
import { ErrorBanner, Field, Loading, Switch } from '../ui'

/**
 * 常规：settings.json 的非模型受管 key（内置工具/默认工具/Shell/缓存提示/codemode）。
 * 模型相关的默认模型、思考级别、启用模型、自建 provider 都在「模型配置」分区。
 * 形状与 pi 1.6 的 settings schema 一致；未知 key 只展示数量，不做编辑。
 */

const CODEMODE_MODES = ['', 'on', 'only'] as const

export function GeneralSection({ home }: { home: string }) {
  const [listing, setListing] = useState<GeneralListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toolsBusy, setToolsBusy] = useState(false)
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      const data = await api.getGeneral(home)
      setListing(data)
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [home])

  useEffect(() => {
    void reload()
  }, [reload])

  if (error) return <ErrorBanner message={error} />
  if (!listing) return <Loading />

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

  async function writeCodemode(mode: string, budget: string) {
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
    <section className="section">
      <div className="detail-sheet is-plain general-page">
        <SectionDetailHead
        title="常规设置"
        meta={`settings.json 受管 key · 其余 ${listing.unmanagedKeys.length} 个 key 不会改动；默认模型与启用模型在「模型配置」分区`}
      />
      <div className="detail-form">
        <div className="settings-form-narrow">
          <div className="stack">
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
            本页只覆盖 settings.json 的非模型项；默认模型、思考级别、启用模型与自建 provider
            在「模型配置」分区，内置 subagent 开关在「Subagent」分区。
          </p>
        </div>
      </div>
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
