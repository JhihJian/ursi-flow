import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { SkillItem, SkillsListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { Badge, EmptyState, ErrorBanner, Loading, Notice } from '../ui'

/**
 * Skills：全局 skills/ 目录列表 + disable-model-invocation 开关。
 * 开关通过 frontmatter 行级切换实现，正文逐字节不变。
 */

const SCOPE_LABEL: Record<SkillItem['scope'], string> = {
  user: '全局',
  'user-agents': '~/.agents',
  project: '项目',
}

export function SkillsSection({ home }: { home: string }) {
  const [listing, setListing] = useState<SkillsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      const data = await api.getSkills(home)
      setListing(data)
      setError(null)
      setSelected((current) =>
        current && data.items.some((s) => s.relDir === current) ? current : (data.items[0]?.relDir ?? null),
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

  const filtered = listing.items.filter((item) => {
    if (!filter) return true
    const needle = filter.toLowerCase()
    return item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle)
  })
  const selectedSkill = listing.items.find((s) => s.relDir === selected) ?? null

  async function toggle(item: SkillItem, disabled: boolean) {
    await runWrite(`${disabled ? '禁用' : '启用'} skill ${item.name}`, async () => {
      await api.toggleSkill(home, item.relDir, disabled)
      await reload()
    })
  }

  return (
    <div className="split-view">
      <div className="split-list">
        <input
          className="input"
          placeholder="搜索 name / description"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginBottom: 'var(--space-2)' }}
        />
        {filtered.map((item) => (
          <button
            key={item.relDir}
            type="button"
            className="list-item"
            role="option"
            aria-current={item.relDir === selected}
            onClick={() => setSelected(item.relDir)}
          >
            <span className="list-item-main">
              <div className="list-item-title">{item.name}</div>
              <div className="list-item-sub">{item.description || '（无描述）'}</div>
            </span>
            <span className="list-item-badges">
              {item.disabled ? <Badge tone="danger">disabled</Badge> : null}
            </span>
          </button>
        ))}
        {filtered.length === 0 ? <EmptyState title="没有匹配的 skill" /> : null}
        {listing.errors.map((err) => (
          <Notice key={err.dir} tone="warn">
            读取 {err.dir} 失败：{err.message}
          </Notice>
        ))}
      </div>

      <div className="split-detail">
        <div className="split-detail-inner">
          {selectedSkill ? (
            <section className="settings-section" key={selectedSkill.relDir}>
              <header className="settings-section-header">
                <h2 className="settings-section-title">{selectedSkill.name}</h2>
                <p className="settings-section-description">{selectedSkill.description || '（无描述）'}</p>
              </header>
              <div className="settings-section-body">
                <div className="kv-grid">
                  <span className="kv-key">位置</span>
                  <span className="kv-value">{SCOPE_LABEL[selectedSkill.scope]} · skills/{selectedSkill.relDir}</span>
                  <span className="kv-key">模型调用</span>
                  <span className="kv-value">
                    {selectedSkill.disableModelInvocation ? (
                      <Badge tone="danger">已禁用（disable-model-invocation: true）</Badge>
                    ) : (
                      <Badge tone="ok">允许</Badge>
                    )}
                  </span>
                </div>
                <div className="field-row">
                  {selectedSkill.scope === 'user' ? (
                    <>
                      {selectedSkill.disableModelInvocation ? (
                        <button type="button" className="btn primary" onClick={() => void toggle(selectedSkill, false)}>
                          启用模型调用
                        </button>
                      ) : (
                        <button type="button" className="btn" onClick={() => void toggle(selectedSkill, true)}>
                          禁用模型调用
                        </button>
                      )}
                      <span className="mono-dim">
                        开关写进 SKILL.md frontmatter（行级切换，正文不变），备份 .bak-manager。
                      </span>
                    </>
                  ) : (
                    <span className="mono-dim">
                      {SCOPE_LABEL[selectedSkill.scope]} 目录的 skill 只读展示；开关请编辑对应 SKILL.md。
                    </span>
                  )}
                </div>
              </div>
            </section>
          ) : (
            <EmptyState title="选择左侧 skill" hint="skills/ 目录为空时这里没有条目。" />
          )}
          <Notice>
            disabled 是打包级禁用（pi 侧 settings/packages 语义），disable-model-invocation
            是单 skill 的模型调用开关；两者互不影响。
          </Notice>
        </div>
      </div>
    </div>
  )
}
