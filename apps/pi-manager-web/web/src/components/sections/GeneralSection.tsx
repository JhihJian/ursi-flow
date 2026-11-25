import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { GeneralListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { ErrorBanner, Field, Loading, Notice, SectionCard } from '../ui'

/**
 * 常规：settings.json 的受管 key（默认模型/思考级别/默认工具/codemode）。
 * 单列窄表单；未知 key 只展示数量，不做编辑。
 */

const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'ultrathought'] as const

export function GeneralSection({ home }: { home: string }) {
  const [listing, setListing] = useState<GeneralListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      setListing(await api.getGeneral(home))
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

  const defaultModel = asModelRef(listing.managed.defaultModel)
  const thinking = typeof listing.managed.defaultThinkingLevel === 'string' ? listing.managed.defaultThinkingLevel : ''
  const defaultTools = Array.isArray(listing.managed.defaultTools)
    ? (listing.managed.defaultTools as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  const codemode = asCodemode(listing.managed.codemode)

  async function writeKey(key: string, value: unknown, label: string) {
    await runWrite(label, async () => {
      const result = await api.putGeneralKey(home, key, value, listing!.revision)
      if (result.changed) await reload()
    })
  }

  return (
    <div className="settings-form-narrow">
      <SectionCard
        title="settings.json 受管项"
        description={`只编辑此处列出的 key；文件里其余 ${listing.unmanagedKeys.length} 个 key 不会被改动。写入后其他进程若修改过文件会被拒绝（乐观锁）。`}
      >
        <Field
          label="默认模型"
          hint="provider/modelId，如 anthropic/claude-sonnet-4-5。留空表示未设置。"
        >
          <div className="field-row">
            <input
              className="input"
              defaultValue={defaultModel}
              placeholder="provider/modelId"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const raw = (e.target as HTMLInputElement).value.trim()
                  const [provider, ...rest] = raw.split('/')
                  void writeKey(
                    'defaultModel',
                    raw && provider && rest.length > 0 ? { provider, modelId: rest.join('/') } : null,
                    '保存默认模型',
                  )
                }
              }}
              onBlur={(e) => {
                const raw = e.target.value.trim()
                if (raw === defaultModel) return
                const [provider, ...rest] = raw.split('/')
                void writeKey(
                  'defaultModel',
                  raw && provider && rest.length > 0 ? { provider, modelId: rest.join('/') } : null,
                  '保存默认模型',
                )
              }}
            />
          </div>
        </Field>

        <Field label="默认思考级别" hint="对应 defaultThinkingLevel；未设置时由 pi 决定。">
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

        <div className="row-between">
          <div>
            <div className="field-label">codemode 自动启用</div>
            <div className="field-hint">defaultTools 以 +codemode 开头时视为 always。</div>
          </div>
          <SwitchInline
            pressed={codemode === 'always'}
            onToggle={(next) =>
              void writeKey('codemode', next ? { mode: 'always' } : null, '保存 codemode')
            }
          />
        </div>
      </SectionCard>

      <Notice>
        本页只覆盖 settings.json；凭据在「凭据」分区，插件条目在「插件」分区，
        内置 subagent 开关在「Subagent」分区。
      </Notice>
    </div>
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

function SwitchInline({
  pressed,
  onToggle,
}: {
  pressed: boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <button type="button" className="switch" aria-pressed={pressed} onClick={() => onToggle(!pressed)}>
      <span className="switch-track" aria-hidden />
    </button>
  )
}

function asModelRef(value: unknown): string {
  if (value && typeof value === 'object') {
    const ref = value as { provider?: unknown; modelId?: unknown }
    if (typeof ref.provider === 'string' && typeof ref.modelId === 'string') {
      return `${ref.provider}/${ref.modelId}`
    }
  }
  return ''
}

function asCodemode(value: unknown): 'unset' | 'automatic' | 'always' {
  if (value && typeof value === 'object') {
    const mode = (value as { mode?: unknown }).mode
    if (mode === 'always' || mode === 'automatic') return mode
  }
  return 'unset'
}
