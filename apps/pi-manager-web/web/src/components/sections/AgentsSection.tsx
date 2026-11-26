import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AgentProfile, AgentProfileFields, AgentsListing, AgentsSettingsView } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { EmptyState, ErrorBanner, Field, Loading, Switch } from '../ui'

/**
 * Subagent：agents/ 目录的 profile 列表 + 内置 agent 开关（agents/settings.json）。
 *
 * profile 编辑对齐 pi-web 的 Agents 面板：受管 frontmatter key 用结构化表单，
 * 其余 key（allowed_subagents、exclude_extensions 等）逐行原样保留，正文是系统提示词。
 * `skills:` / `extensions:` 白名单只读展示，开关只写 load_skills / load_extensions。
 */

const BUILTIN_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'] as const
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

interface ProfileDraft {
  name: string
  description: string
  fields: AgentProfileFields
  presentKeys: string[]
  extraKeys: string[]
  unparsedKeys: string[]
  body: string
}

function emptyFields(): AgentProfileFields {
  return {
    displayName: null,
    model: null,
    thinking: null,
    tools: null,
    loadSkills: false,
    loadExtensions: false,
    codemode: 'off',
    mcp: 'off',
    enabled: true,
    inheritContext: false,
    runInBackground: false,
    promptMode: 'append',
    maxTurns: null,
    color: null,
    isolation: null,
    persistSession: null,
    skillsAlias: null,
    extensionsAlias: null,
  }
}

function draftOf(profile: AgentProfile): ProfileDraft {
  return {
    name: profile.name,
    description: profile.description,
    fields: profile.fields,
    presentKeys: profile.presentKeys,
    extraKeys: profile.extraKeys,
    unparsedKeys: profile.unparsedKeys ?? [],
    body: profile.body.replace(/^\n+/, ''),
  }
}

export function AgentsSection({ home }: { home: string }) {
  const [listing, setListing] = useState<AgentsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      const data = await api.getAgents(home)
      setListing(data)
      setError(null)
      setCreating(false)
      setSelected((current) =>
        current && data.profiles.some((p) => p.file === current)
          ? current
          : (data.profiles[0]?.file ?? null),
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

  const selectedProfile = listing.profiles.find((p) => p.file === selected) ?? null

  async function save(file: string, draft: ProfileDraft, revision: string) {
    const ok = await runWrite(`保存 profile ${draft.name}`, async () => {
      await api.putAgentProfile(home, {
        file: file || `${draft.name.trim()}.md`,
        name: draft.name,
        description: draft.description,
        fields: draft.fields,
        presentKeys: draft.presentKeys,
        extraKeys: draft.extraKeys,
        body: draft.body,
        revision,
      })
      await reload()
    })
    return ok
  }

  return (
    <section className="section">
      <header className="section-head">
        <h1 className="section-title">Subagent</h1>
        <button type="button" className="btn small" onClick={() => setCreating(true)}>
          新增 profile
        </button>
      </header>
      {listing.profiles.length > 0 ? (
        <table className="item-table">
          <thead>
            <tr>
              <th className="col-state">On</th>
              <th>Profile</th>
              <th className="col-size">File</th>
            </tr>
          </thead>
          <tbody>
            {listing.profiles.map((profile) => (
              <tr
                key={profile.file}
                className={profile.file === selected && !creating ? 'is-selected' : undefined}
                title={profile.description}
                onClick={() => {
                  setCreating(false)
                  setSelected(profile.file)
                }}
              >
                <td className="col-state">
                  <span className={`state-mark${profile.fields.enabled ? '' : ' off'}`}>
                    {profile.fields.enabled ? '✓' : '×'}
                  </span>
                </td>
                <td>
                  <div className="cell-title">{profile.name}</div>
                  <div className="cell-sub">{profile.description || '（无描述）'}</div>
                </td>
                <td className="col-size">{profile.file}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="agents/ 目录没有 profile" hint="点击右上角「新增 profile」。" />
      )}

      {creating ? (
        <ProfileEditor
          key="__new__"
          file=""
          initial={{
            name: '',
            description: '',
            fields: emptyFields(),
            presentKeys: [],
            extraKeys: [],
            unparsedKeys: [],
            body: '',
          }}
          isNew
          onSave={(draft) => save('', draft, '')}
          onCancel={() => setCreating(false)}
        />
      ) : selectedProfile ? (
        <ProfileEditor
          key={selectedProfile.file}
          file={selectedProfile.file}
          initial={draftOf(selectedProfile)}
          revision={selectedProfile.revision}
          onSave={(draft) => save(selectedProfile.file, draft, selectedProfile.revision)}
          onDelete={async () => {
            const ok = await runWrite(`删除 profile ${selectedProfile.file}`, async () => {
              await api.deleteAgentProfile(home, selectedProfile.file)
              await reload()
            })
            return ok
          }}
        />
      ) : null}
      <BuiltInCard settings={listing.settings} onSaved={reload} />
    </section>
  )
}

function ProfileEditor({
  file,
  initial,
  revision,
  isNew,
  onSave,
  onDelete,
  onCancel,
}: {
  file: string
  initial: ProfileDraft
  revision?: string
  isNew?: boolean
  onSave: (draft: ProfileDraft) => Promise<boolean>
  onDelete?: () => Promise<boolean>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [fields, setFields] = useState<AgentProfileFields>(initial.fields)
  const [extraText, setExtraText] = useState(initial.extraKeys.join('\n'))
  const [body, setBody] = useState(initial.body)
  const [toolExtra, setToolExtra] = useState(
    (initial.fields.tools ?? []).filter((tool) => !(BUILTIN_TOOLS as readonly string[]).includes(tool)).join(', '),
  )
  const nameValid = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name.trim().length > 0
  const tools = fields.tools
  const selectedBuiltin = (tools ?? []).filter((tool) => (BUILTIN_TOOLS as readonly string[]).includes(tool))

  function patch(next: Partial<AgentProfileFields>) {
    setFields((current) => ({ ...current, ...next }))
  }

  function commitTools(nextBuiltin: string[], nextExtra = toolExtra) {
    const extras = nextExtra
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    patch({ tools: [...nextBuiltin, ...extras] })
  }

  function toggleBuiltinTool(tool: string, enabled: boolean) {
    const next = enabled
      ? [...selectedBuiltin, tool]
      : selectedBuiltin.filter((item) => item !== tool)
    commitTools(next)
  }

  const draft: ProfileDraft = {
    name,
    description,
    fields: { ...fields, tools },
    presentKeys: initial.presentKeys,
    extraKeys: extraText
      .split('\n')
      .filter((line) => line.trim().length > 0),
    unparsedKeys: initial.unparsedKeys,
    body,
  }

  return (
    <div className="detail-sheet">
      <div className="detail-grip" aria-hidden />
      <div className="detail-body">
        <div className="detail-head">
          <h2 className="detail-title">{isNew ? '新增 profile' : file}</h2>
          <span className="detail-meta">
            受管 key 用表单编辑，其余 frontmatter key 原样保留；保存为 agents/&lt;name&gt;.md
          </span>
        </div>
        <div className="detail-form">
          {initial.unparsedKeys.length > 0 ? (
            <p className="section-warn">
              这些受管 key 的值不是标准写法，保存时原样保留：{initial.unparsedKeys.join('、')}。在表单里改动后才会重写。
            </p>
          ) : null}
          <div className="detail-grid">
            <Field label="name（文件名）" hint={isNew ? undefined : '已有 profile 不能在这里改名：文件名必须与 name 一致。'}>
              <input
                className="input"
                value={name}
                readOnly={!isNew}
                onChange={(e) => setName(e.target.value)}
                placeholder="如 code-reviewer"
              />
            </Field>
            <Field label="description（何时使用该 agent）">
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="display_name（可留空）">
              <input
                className="input"
                value={fields.displayName ?? ''}
                onChange={(e) => patch({ displayName: e.target.value.trim() || null })}
              />
            </Field>
          </div>

          <div className="detail-grid">
            <Field label="model" hint="如 provider/modelId；留空继承父会话。">
              <input
                className="input"
                value={fields.model ?? ''}
                onChange={(e) => patch({ model: e.target.value.trim() || null })}
              />
            </Field>
            <Field label="thinking">
              <select
                className="select"
                value={fields.thinking ?? ''}
                onChange={(e) => patch({ thinking: e.target.value || null })}
              >
                <option value="">（未设置）</option>
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="max_turns" hint="正数；留空不限制。">
              <input
                className="input"
                inputMode="numeric"
                value={fields.maxTurns === null ? '' : String(fields.maxTurns)}
                onChange={(e) => {
                  const value = Number.parseInt(e.target.value, 10)
                  patch({ maxTurns: Number.isFinite(value) && value > 0 ? value : null })
                }}
              />
            </Field>
          </div>

          <Field
            label="tools"
            hint="勾选内置工具；扩展工具写成 ext:<name>，可逗号分隔。一个都不勾等于 tools: none。"
          >
            <div className="tool-switches">
              {BUILTIN_TOOLS.map((tool) => (
                <label key={tool} className="tool-switch">
                  <input
                    type="checkbox"
                    checked={selectedBuiltin.includes(tool)}
                    onChange={(e) => toggleBuiltinTool(tool, e.target.checked)}
                  />
                  <span>{tool}</span>
                </label>
              ))}
            </div>
            <input
              className="input"
              value={toolExtra}
              placeholder="ext:codegraph, some-tool"
              onChange={(e) => {
                setToolExtra(e.target.value)
                commitTools(selectedBuiltin, e.target.value)
              }}
            />
            {tools === null ? (
              <span className="field-hint">文件未写 tools，跟随 pi 默认；勾选任意工具后会写入 tools。</span>
            ) : (
              <label className="tool-switch">
                <input
                  type="checkbox"
                  checked={tools.length > 0}
                  onChange={(e) => patch({ tools: e.target.checked ? ['read', 'bash', 'edit', 'write'] : [] })}
                />
                <span>限制工具集（取消勾选写成 tools: none）</span>
              </label>
            )}
          </Field>

          <div className="detail-grid">
            <Field label="load_skills" hint="是否加载 pi 的 skills。">
              <Switch
                pressed={fields.loadSkills}
                label={fields.loadSkills ? '加载' : '不加载'}
                onChange={(next) => patch({ loadSkills: next })}
              />
              {fields.skillsAlias ? (
                <span className="field-hint">文件里的 skills 白名单（只读）：{fields.skillsAlias.join('、')}</span>
              ) : null}
            </Field>
            <Field label="load_extensions" hint="是否加载 extensions。">
              <Switch
                pressed={fields.loadExtensions}
                label={fields.loadExtensions ? '加载' : '不加载'}
                onChange={(next) => patch({ loadExtensions: next })}
              />
              {fields.extensionsAlias ? (
                <span className="field-hint">
                  文件里的 extensions 白名单（只读）：{fields.extensionsAlias.join('、')}
                </span>
              ) : null}
            </Field>
            <Field label="codemode">
              <select
                className="select"
                value={fields.codemode}
                onChange={(e) => patch({ codemode: e.target.value as AgentProfileFields['codemode'] })}
              >
                <option value="off">off</option>
                <option value="inherit">inherit（跟随父会话）</option>
                <option value="on">on</option>
              </select>
            </Field>
            <Field label="mcp">
              <select
                className="select"
                value={fields.mcp}
                onChange={(e) => patch({ mcp: e.target.value as AgentProfileFields['mcp'] })}
              >
                <option value="off">off</option>
                <option value="on">on</option>
              </select>
            </Field>
            <Field label="prompt_mode">
              <select
                className="select"
                value={fields.promptMode}
                onChange={(e) => patch({ promptMode: e.target.value as AgentProfileFields['promptMode'] })}
              >
                <option value="append">append</option>
                <option value="replace">replace</option>
              </select>
            </Field>
          </div>

          <div className="detail-grid">
            <Field label="enabled">
              <Switch
                pressed={fields.enabled}
                label={fields.enabled ? '启用' : '停用'}
                onChange={(next) => patch({ enabled: next })}
              />
            </Field>
            <Field label="inherit_context">
              <Switch
                pressed={fields.inheritContext}
                label={fields.inheritContext ? '继承父上下文' : '不继承'}
                onChange={(next) => patch({ inheritContext: next })}
              />
            </Field>
            <Field label="run_in_background">
              <Switch
                pressed={fields.runInBackground}
                label={fields.runInBackground ? '默认后台运行' : '默认前台'}
                onChange={(next) => patch({ runInBackground: next })}
              />
            </Field>
            <Field label="isolation">
              <select
                className="select"
                value={fields.isolation ?? ''}
                onChange={(e) =>
                  patch({ isolation: (e.target.value || null) as AgentProfileFields['isolation'] })
                }
              >
                <option value="">（未设置）</option>
                <option value="off">off</option>
                <option value="worktree">worktree</option>
              </select>
            </Field>
            <Field label="persist_session">
              <select
                className="select"
                value={fields.persistSession === null ? '' : String(fields.persistSession)}
                onChange={(e) =>
                  patch({
                    persistSession:
                      e.target.value === '' ? null : e.target.value === 'true',
                  })
                }
              >
                <option value="">（未设置）</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </Field>
            <Field label="color">
              <input
                className="input"
                value={fields.color ?? ''}
                onChange={(e) => patch({ color: e.target.value.trim() || null })}
              />
            </Field>
          </div>

          <Field
            label="其它 frontmatter key"
            hint="每行一条原样保留，如 allowed_subagents: explore。受管 key 不要写在这里。"
          >
            <textarea
              className="textarea code"
              value={extraText}
              onChange={(e) => setExtraText(e.target.value)}
              style={{ minHeight: 64 }}
            />
          </Field>
          <Field label="系统提示词正文">
            <textarea
              className="textarea code"
              value={body}
              spellCheck={false}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <div className="field-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!nameValid}
              onClick={() => void onSave(draft)}
            >
              保存
            </button>
            {onDelete && file ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  if (window.confirm(`删除 profile ${file}？`)) void onDelete()
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
            {revision ? <span className="detail-hint">写入前用 revision 做乐观锁</span> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function BuiltInCard({
  settings,
  onSaved,
}: {
  settings: AgentsSettingsView
  onSaved: () => Promise<void>
}) {
  const home = useHome()
  const [maxConcurrent, setMaxConcurrent] = useState(settings.maxConcurrent ? String(settings.maxConcurrent) : '')
  const [disabledText, setDisabledText] = useState(settings.disabledBuiltIns.join(', '))

  async function save() {
    await useAppStore.getState().runWrite('保存内置 agent 设置', async () => {
      const parsedMax = Number.parseInt(maxConcurrent, 10)
      await api.putAgentsSettings(home, {
        builtInEnabled: settings.builtInEnabled,
        disabledBuiltIns: disabledText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        maxConcurrent: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null,
        revision: settings.revision,
      })
      await onSaved()
    })
  }

  return (
    <div className="detail-sheet">
      <div className="detail-grip" aria-hidden />
      <div className="detail-body">
        <div className="detail-head">
          <h2 className="detail-title">内置 agent</h2>
          <span className="detail-meta">agents/settings.json · 禁用列表里的内置 agent 不再加载</span>
        </div>
        <div className="detail-form">
          <div className="row-between">
            <Switch
              pressed={settings.builtInEnabled}
              label={settings.builtInEnabled ? '启用内置 agent' : '停用内置 agent'}
              onChange={async (next) => {
                await useAppStore.getState().runWrite('切换内置 agent', async () => {
                  await api.putAgentsSettings(home, {
                    builtInEnabled: next,
                    disabledBuiltIns: settings.disabledBuiltIns,
                    maxConcurrent: settings.maxConcurrent,
                    revision: settings.revision,
                  })
                  await onSaved()
                })
              }}
            />
            {!settings.exists ? <span className="detail-hint">文件尚不存在，保存后创建</span> : null}
          </div>
          <div className="detail-grid">
            <Field label="禁用的内置 agent" hint="逗号分隔，如 Explore, compaction；留空全部启用。">
              <input
                className="input"
                value={disabledText}
                onChange={(e) => setDisabledText(e.target.value)}
                placeholder="Explore, compaction"
              />
            </Field>
            <Field label="maxConcurrent" hint="并发上限；留空由 pi 决定。">
              <input
                className="input"
                value={maxConcurrent}
                inputMode="numeric"
                onChange={(e) => setMaxConcurrent(e.target.value)}
                placeholder="如 4"
              />
            </Field>
          </div>
          <div className="field-row">
            <button type="button" className="btn btn-primary" onClick={() => void save()}>
              保存设置
            </button>
            <span className="detail-hint">profile 与内置开关都是全局 agents/；项目级 .pi/agents/ 本页不编辑。</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function useHome(): string {
  return useAppStore((s) => s.homePath)
}
