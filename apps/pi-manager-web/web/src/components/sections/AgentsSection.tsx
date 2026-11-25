import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AgentsListing, AgentsSettingsView } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { Badge, EmptyState, ErrorBanner, Field, Loading, Notice, SectionCard } from '../ui'

/**
 * Subagent：agents/ 目录的 profile 列表 + 内置 agent 开关（agents/settings.json）。
 * profile 编辑走 name/description/正文 表单；未知 frontmatter key 原样保留。
 */

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

  return (
    <div className="split-view">
      <div className="split-list" role="listbox" aria-label="subagent profile">
        {listing.profiles.map((profile) => (
          <button
            key={profile.file}
            type="button"
            className="list-item"
            role="option"
            aria-current={profile.file === selected && !creating}
            onClick={() => {
              setCreating(false)
              setSelected(profile.file)
            }}
          >
            <span className="list-item-main">
              <div className="list-item-title">{profile.name}</div>
              <div className="list-item-sub">{profile.description || '（无描述）'}</div>
            </span>
            {profile.extraKeys.length > 0 ? (
              <span className="list-item-badges">
                <Badge>{profile.extraKeys.length} 扩展键</Badge>
              </span>
            ) : null}
          </button>
        ))}
        {listing.profiles.length === 0 ? (
          <EmptyState title="agents/ 目录没有 profile" hint="下方按钮新增。" />
        ) : null}
        <div style={{ marginTop: 'auto', paddingTop: 'var(--space-3)' }}>
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            新增 profile
          </button>
        </div>
      </div>

      <div className="split-detail">
        <div className="split-detail-inner">
          {creating ? (
            <ProfileEditor
              key="__new__"
              file=""
              initial={null}
              onSave={async (file, payload) => {
                const ok = await runWrite(`新增 profile ${payload.name}`, async () => {
                  await api.putAgentProfile(home, { file, ...payload, revision: '' })
                  await reload()
                })
                return ok
              }}
            />
          ) : selectedProfile ? (
            <ProfileDetail key={selectedProfile.file} home={home} file={selectedProfile.file} onSaved={reload} />
          ) : (
            <EmptyState title="选择或新增 profile" />
          )}
          <BuiltInCard settings={listing.settings} onSaved={reload} />
        </div>
      </div>
    </div>
  )
}

interface ProfilePayload {
  name: string
  description: string
  extraKeys: string[]
  body: string
}

function ProfileDetail({
  home,
  file,
  onSaved,
}: {
  home: string
  file: string
  onSaved: () => Promise<void>
}) {
  const [detail, setDetail] = useState<{ content: string; revision: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getAgentProfile(home, file)
      .then((d) => {
        if (!cancelled) setDetail({ content: d.content, revision: d.revision })
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [home, file])

  if (error) return <ErrorBanner message={error} />
  if (!detail) return <Loading />

  const { name, description, extraKeys, body } = splitProfileText(detail.content)

  return (
    <ProfileEditor
      file={file}
      initial={{ name, description, extraKeys, body }}
      revision={detail.revision}
      onSave={async (_file, payload, revision) => {
        const ok = await useAppStore
          .getState()
          .runWrite(`保存 profile ${payload.name}`, async () => {
            await api.putAgentProfile(home, { file, ...payload, revision })
            await onSaved()
          })
        return ok
      }}
      onDelete={async () => {
        const ok = await useAppStore.getState().runWrite(`删除 profile ${file}`, async () => {
          await api.deleteAgentProfile(home, file)
          await onSaved()
        })
        return ok
      }}
    />
  )
}

function ProfileEditor({
  file,
  initial,
  revision,
  onSave,
  onDelete,
}: {
  file: string
  initial: ProfilePayload | null
  revision?: string
  onSave: (file: string, payload: ProfilePayload, revision: string) => Promise<boolean>
  onDelete?: () => Promise<boolean>
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [extraText, setExtraText] = useState((initial?.extraKeys ?? []).join('\n'))
  const nameValid = /^[a-z0-9][a-z0-9-]*$/.test(name)
  const extraKeys = extraText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <h2 className="settings-section-title">{file ? file : '新增 profile'}</h2>
        <p className="settings-section-description">
          保存为 agents/&lt;name&gt;.md；frontmatter 之外的扩展 key 原样保留（如 model、tools）。
        </p>
      </header>
      <div className="settings-section-body">
        <Field label="name（也是文件名，小写字母数字与 -）">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 code-reviewer"
            style={{ maxWidth: 260 }}
          />
        </Field>
        <Field label="description（何时使用该 agent）">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="扩展 frontmatter key" hint="每行一条，如 model: claude-sonnet-4-5；留空则没有。">
          <textarea
            className="textarea"
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
            className="btn primary"
            disabled={!nameValid || !name.trim()}
            onClick={() =>
              void onSave(file, { name, description, extraKeys, body }, revision ?? '')
            }
          >
            保存
          </button>
          {onDelete && file ? (
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                if (window.confirm(`删除 profile ${file}？`)) void onDelete()
              }}
            >
              删除
            </button>
          ) : null}
        </div>
      </div>
    </section>
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
    <SectionCard
      title="内置 agent"
      description="写到 agents/settings.json（不是主 settings.json）；禁用列表里出现过的内置 agent 不再加载。"
    >
      <div className="row-between">
        <span className="field-label">启用内置 agent</span>
        <button
          type="button"
          className="switch"
          aria-pressed={settings.builtInEnabled}
          onClick={async () => {
            await useAppStore.getState().runWrite('切换内置 agent', async () => {
              await api.putAgentsSettings(home, {
                builtInEnabled: !settings.builtInEnabled,
                disabledBuiltIns: settings.disabledBuiltIns,
                maxConcurrent: settings.maxConcurrent,
                revision: settings.revision,
              })
              await onSaved()
            })
          }}
        >
          <span className="switch-track" aria-hidden />
        </button>
      </div>
      <Field label="禁用的内置 agent" hint="逗号分隔的名字，如 Explore, compaction。留空表示全部启用。">
        <input
          className="input"
          value={disabledText}
          onChange={(e) => setDisabledText(e.target.value)}
          placeholder="Explore, compaction"
        />
      </Field>
      <Field label="maxConcurrent" hint="单个会话内 subagent 的并发上限；留空表示由 pi 决定。">
        <input
          className="input"
          value={maxConcurrent}
          inputMode="numeric"
          onChange={(e) => setMaxConcurrent(e.target.value)}
          placeholder="如 4"
          style={{ maxWidth: 120 }}
        />
      </Field>
      <div className="field-row">
        <button type="button" className="btn primary" onClick={() => void save()}>
          保存设置
        </button>
        {!settings.exists ? <span className="mono-dim">agents/settings.json 尚不存在，保存后创建。</span> : null}
      </div>
      <Notice>
        profile 与内置开关都是全局 agents/ 目录；项目级 .pi/agents/ 本页不编辑。
      </Notice>
    </SectionCard>
  )
}

function useHome(): string {
  return useAppStore((s) => s.homePath)
}

function splitProfileText(content: string): ProfilePayload {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  if (!m) return { name: '', description: '', extraKeys: [], body: content }
  const [, frontmatter, body] = m
  const nameLine = frontmatter.split(/\r?\n/).find((l) => l.startsWith('name:'))
  const descLine = frontmatter.split(/\r?\n/).find((l) => l.startsWith('description:'))
  const valueOf = (line: string | undefined) =>
    line ? line.slice(line.indexOf(':') + 1).trim() : ''
  const extraKeys = frontmatter
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('name:') && !l.startsWith('description:'))
  return {
    name: valueOf(nameLine),
    description: valueOf(descLine),
    extraKeys,
    body,
  }
}
