import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { PackageEntryView, PluginsListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { SectionDetailHead, SectionFooterNote, SectionListHead, SectionListItem, SectionSplit } from '../layout'
import { EmptyState, ErrorBanner, Loading } from '../ui'

/**
 * 插件（settings.json 的 packages 条目 + npm/ 安装目录核对）。
 * 禁用 = 编码为四空数组 object；带资源过滤列表的条目拒绝禁用（服务端 409）。
 * 安装/升级不在此处：用 pi CLI。
 */

export function PluginsSection({ home }: { home: string }) {
  const [listing, setListing] = useState<PluginsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      const data = await api.getPlugins(home)
      setListing(data)
      setError(null)
      setSelected((current) =>
        current !== null && current < data.packages.length ? current : (data.packages[0]?.index ?? null),
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

  const selectedEntry = listing.packages.find((p) => p.index === selected) ?? null

  async function mutate(entry: PackageEntryView, action: 'enable' | 'disable' | 'remove') {
    await runWrite(`${actionLabel(action)} ${entry.source}`, async () => {
      await api.mutatePluginEntry(home, action, entry.index, listing!.revision)
      await reload()
    })
  }

  return (
    <SectionSplit
      list={
        <>
          <SectionListHead title="插件" />
          {listing.packages.map((entry) => (
            <SectionListItem
              key={entry.index}
              active={entry.index === selected}
              data-mark={entry.disabled ? 'off' : 'ok'}
              title={entry.source || '（无 source）'}
              sub={`${entry.kind === 'plain' ? 'string 形式（启用）' : 'object 形式'}${entry.autoload ? ' · autoload' : ''}`}
              badges={entry.hasFilters ? <span className="badge warn">filters</span> : undefined}
              onClick={() => setSelected(entry.index)}
            />
          ))}
          {listing.packages.length === 0 ? (
            <p className="mono-dim">settings.json 没有 packages 条目；用 pi CLI 安装后这里会出现。</p>
          ) : null}
        </>
      }
      footer={
        <SectionFooterNote note="安装、升级与清理用 pi CLI 完成；这里只切换启用状态与移除条目。禁用不卸载，npm/ 保持原样。" />
      }
      detail={
        selectedEntry ? (
          <div className="detail-sheet is-plain" key={selectedEntry.index}>
            <SectionDetailHead
              title={selectedEntry.source}
              meta={`条目 #${selectedEntry.index} · ${selectedEntry.installedDir ? `npm/${selectedEntry.installedDir}` : '未检测到安装目录'}`}
            />
            {selectedEntry.hasFilters ? (
              <p className="section-warn">
                该条目带资源过滤列表（extensions/skills/prompts/themes 非空）。禁用会永久丢失过滤信息，
                服务端会拒绝；请直接编辑 settings.json。
              </p>
            ) : null}
            <div className="field-row">
              {selectedEntry.disabled ? (
                <button type="button" className="btn btn-primary" onClick={() => void mutate(selectedEntry, 'enable')}>
                  启用
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => void mutate(selectedEntry, 'disable')}>
                  禁用
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  if (window.confirm(`从 settings.json 移除 ${selectedEntry.source}？npm/ 目录不会删除。`)) {
                    void mutate(selectedEntry, 'remove')
                  }
                }}
              >
                移除条目
              </button>
            </div>
          </div>
        ) : (
          <EmptyState title="没有选中的插件" hint="在左侧选择一个条目。" />
        )
      }
    />
  )
}

function actionLabel(action: 'enable' | 'disable' | 'remove'): string {
  return action === 'enable' ? '启用' : action === 'disable' ? '禁用' : '移除'
}
