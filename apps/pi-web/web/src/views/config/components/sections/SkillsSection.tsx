import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { SkillContent, SkillItem, SkillsListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { SectionDetailHead, SectionListHead, SectionListItem, SectionSplit } from '../layout'
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
    <SectionSplit
      list={
        <>
          <SectionListHead
            title="Skills"
            actions={
              <input
                className="filter-input"
                placeholder="Filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="过滤 skills"
              />
            }
          />
          {filtered.map((item) => (
            <SectionListItem
              key={item.relDir}
              active={item.relDir === selected}
              mark={item.disableModelInvocation ? 'off' : 'ok'}
              title={item.name}
              sub={item.description || '（无描述）'}
              badges={<span className="badge">{formatBytes(item.bytes)}</span>}
              onClick={() => setSelected(item.relDir)}
            />
          ))}
          {filtered.length === 0 ? (
            <p className="mono-dim">{needle ? '没有匹配的 skill' : 'skills/ 目录为空'}。</p>
          ) : null}
        </>
      }
      detail={
        selectedSkill ? (
          <div className="detail-sheet is-plain">
            <SectionDetailHead
              title={selectedSkill.name}
              meta={`skills/${selectedSkill.relDir} · ${formatBytes(selectedSkill.bytes)}`}
              actions={
                selectedSkill.disableModelInvocation ? (
                  <button type="button" className="btn btn-primary" onClick={() => void toggle(selectedSkill, false)}>
                    启用模型调用
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={() => void toggle(selectedSkill, true)}>
                    禁用模型调用
                  </button>
                )
              }
            />
            {listing.warnings.map((w, i) => (
              <p key={i} className="section-warn">
                {w}
              </p>
            ))}
            <p className="detail-desc">{selectedSkill.description || '（无描述）'}</p>
            <SkillContentView home={home} relDir={selectedSkill.relDir} />
            <p className="detail-hint">
              开关写进 SKILL.md frontmatter（行级切换，正文不变），备份 .bak-manager。
            </p>
          </div>
        ) : (
          <EmptyState title="没有选中的 skill" hint="在左侧选择一个 skill。" />
        )
      }
    />
  )
}

/**
 * 选中 skill 的只读内容：frontmatter 原条目 + 正文。
 * 与 pi-web 的 Skills 详情一致，开关只改 frontmatter 的一行，正文逐字节不变，
 * 因此正文预览就是文件真实内容。
 */
function SkillContentView({ home, relDir }: { home: string; relDir: string }) {
  const [content, setContent] = useState<SkillContent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    api
      .getSkillContent(home, relDir)
      .then((data) => {
        if (!cancelled) setContent(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [home, relDir])

  if (error) return <ErrorBanner message={error} />
  if (!content) return <Loading label="读取 SKILL.md" />

  return (
    <div className="skill-content">
      {content.frontmatter.length > 0 ? (
        <table className="skill-frontmatter">
          <tbody>
            {content.frontmatter.map((entry) => (
              <tr key={entry.key}>
                <th>{entry.key}</th>
                <td>{entry.value || '（空）'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="section-warn">该文件没有 frontmatter；禁用模型调用会失败，需要先补 frontmatter。</p>
      )}
      <pre className="skill-body">{content.body.trim() || '（正文为空）'}</pre>
    </div>
  )
}
