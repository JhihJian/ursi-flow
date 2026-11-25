import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { PackageEntryView, PluginsListing } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { Badge, EmptyState, ErrorBanner, Loading, Notice } from '../ui'

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
    <div className="split-view">
      <div className="split-list" role="listbox" aria-label="插件条目">
        {listing.packages.map((entry) => (
          <button
            key={entry.index}
            type="button"
            className="list-item"
            role="option"
            aria-current={entry.index === selected}
            onClick={() => setSelected(entry.index)}
          >
            <span className="list-item-main">
              <div className="list-item-title">{entry.source || '（无 source）'}</div>
              <div className="list-item-sub">
                {entry.installedDir ? `npm/${entry.installedDir}` : '（npm/ 未检测到安装目录）'}
              </div>
            </span>
            <span className="list-item-badges">
              {entry.disabled ? <Badge tone="danger">disabled</Badge> : <Badge tone="ok">on</Badge>}
              {entry.hasFilters ? <Badge tone="warn">filters</Badge> : null}
            </span>
          </button>
        ))}
        {listing.packages.length === 0 ? (
          <EmptyState title="settings.json 没有 packages 条目" hint="用 pi CLI 安装插件后这里会出现。" />
        ) : null}
      </div>

      <div className="split-detail">
        <div className="split-detail-inner">
          {selectedEntry ? (
            <section className="settings-section" key={selectedEntry.index}>
              <header className="settings-section-header">
                <h2 className="settings-section-title">{selectedEntry.source}</h2>
                <p className="settings-section-description">
                  条目 #{selectedEntry.index} · {selectedEntry.kind === 'plain' ? 'string 形式（启用）' : 'object 形式'}
                  {selectedEntry.autoload ? ' · autoload' : ''}
                </p>
              </header>
              <div className="settings-section-body">
                <div className="kv-grid">
                  <span className="kv-key">安装目录</span>
                  <span className="kv-value">{selectedEntry.installedDir ?? '未检测到（可能未安装或来源非 npm 包名）'}</span>
                </div>
                {selectedEntry.hasFilters ? (
                  <Notice tone="warn">
                    该条目带资源过滤列表（extensions/skills/prompts/themes 非空）。禁用会永久丢失过滤信息，
                    服务端会拒绝；请直接编辑 settings.json。
                  </Notice>
                ) : null}
                <div className="field-row">
                  {selectedEntry.disabled ? (
                    <button type="button" className="btn primary" onClick={() => void mutate(selectedEntry, 'enable')}>
                      启用
                    </button>
                  ) : (
                    <button type="button" className="btn" onClick={() => void mutate(selectedEntry, 'disable')}>
                      禁用
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn danger"
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
            </section>
          ) : (
            <EmptyState title="选择左侧插件条目" />
          )}
          <Notice>
            禁用不卸载：npm/ 目录保持原样，pi 下次会话不再加载。安装、升级与清理用 pi CLI 完成。
          </Notice>
        </div>
      </div>
    </div>
  )
}

function actionLabel(action: 'enable' | 'disable' | 'remove'): string {
  return action === 'enable' ? '启用' : action === 'disable' ? '禁用' : '移除'
}
