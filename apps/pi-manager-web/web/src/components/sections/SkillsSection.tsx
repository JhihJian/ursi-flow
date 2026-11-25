import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { SkillItem, SkillsListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { EmptyState, ErrorBanner, Loading } from '../ui'

/**
 * Skills：全局 skills/ 目录列表 + disable-model-invocation 开关。
 * 开关通过 frontmatter 行级切换实现，正文逐字节不变。
 */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
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
        current && data.skills.some((s) => s.relDir === current) ? current : (data.skills[0]?.relDir ?? null),
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

  const needle = filter.toLowerCase()
  const filtered = listing.skills.filter(
    (item) =>
      !needle ||
      item.name.toLowerCase().includes(needle) ||
      item.description.toLowerCase().includes(needle),
  )
  const selectedSkill = listing.skills.find((s) => s.relDir === selected) ?? null

  async function toggle(item: SkillItem, disabled: boolean) {
    await runWrite(`${disabled ? '禁用' : '启用'} skill ${item.name}`, async () => {
      await api.toggleSkill(home, item.relDir, disabled)
      await reload()
    })
  }

  return (
    <section className="section">
      <header className="section-head">
        <h1 className="section-title">Skills</h1>
        <input
          className="filter-input"
          placeholder="Filter skills"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="过滤 skills"
        />
      </header>
      {listing.warnings.map((w, i) => (
        <p key={i} className="section-warn">
          {w}
        </p>
      ))}
      {filtered.length > 0 ? (
        <table className="item-table">
          <thead>
            <tr>
              <th className="col-state">Model</th>
              <th>Name</th>
              <th className="col-size">Size</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => (
              <tr
                key={item.relDir}
                className={item.relDir === selected ? 'is-selected' : undefined}
                onClick={() => setSelected(item.relDir)}
                title={item.filePath}
              >
                <td className="col-state">
                  <span className={`state-mark${item.disableModelInvocation ? ' off' : ''}`} aria-hidden>
                    {item.disableModelInvocation ? '×' : '✓'}
                  </span>
                </td>
                <td>
                  <div className="cell-title">{item.name}</div>
                  <div className="cell-sub">{item.description || '（无描述）'}</div>
                </td>
                <td className="col-size">{formatBytes(item.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title={needle ? '没有匹配的 skill' : 'skills/ 目录为空'} />
      )}

      {selectedSkill ? (
        <div className="detail-sheet">
          <div className="detail-grip" aria-hidden />
          <div className="detail-body">
            <div className="detail-head">
              <h2 className="detail-title">{selectedSkill.name}</h2>
              <span className="detail-meta">
                skills/{selectedSkill.relDir} · {formatBytes(selectedSkill.bytes)}
              </span>
            </div>
            <p className="detail-desc">{selectedSkill.description || '（无描述）'}</p>
            <div className="detail-actions">
              {selectedSkill.disableModelInvocation ? (
                <button type="button" className="btn btn-primary" onClick={() => void toggle(selectedSkill, false)}>
                  启用模型调用
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => void toggle(selectedSkill, true)}>
                  禁用模型调用
                </button>
              )}
              <span className="detail-hint">
                开关写进 SKILL.md frontmatter（行级切换，正文不变），备份 .bak-manager。
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
