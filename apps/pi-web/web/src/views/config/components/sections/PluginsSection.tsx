import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type {
  BuiltinExtensionsListing,
  BuiltinExtensionEntry,
  PackageEntryView,
  PluginsListing,
} from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { SectionDetailHead, SectionFooterNote, SectionListHead, SectionListItem, SectionSplit } from '../layout'
import { EmptyState, ErrorBanner, Loading, confirmDialog } from '../ui'

/**
 * 插件（settings.json 的 packages 条目 + npm/ 安装目录核对 + 内置扩展一键安装）。
 * 禁用 = 编码为四空数组 object；带资源过滤列表的条目拒绝禁用（服务端 409）。
 * npm 包的安装/升级仍用 pi CLI；随本服务自带的内置扩展在这里一键安装。
 */

export function PluginsSection({ home }: { home: string }) {
  const [listing, setListing] = useState<PluginsListing | null>(null)
  const [builtin, setBuiltin] = useState<BuiltinExtensionsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [selectedBuiltin, setSelectedBuiltin] = useState<string | null>(null)
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

  const reloadBuiltin = useCallback(async () => {
    try {
      const data = await api.getBuiltinExtensions(home)
      setBuiltin(data)
      setSelectedBuiltin((current) =>
        current && data.extensions.some((entry) => entry.id === current)
          ? current
          : (data.extensions[0]?.id ?? null),
      )
    } catch {
      // 内置扩展清单读不到不影响 npm 条目分区，只在列表里留空。
      setBuiltin({ extensions: [], heartbeatDetected: false })
    }
  }, [home])

  useEffect(() => {
    void reload()
    void reloadBuiltin()
  }, [reload, reloadBuiltin])

  if (error) return <ErrorBanner message={error} />
  if (!listing) return <Loading />

  const selectedEntry = listing.packages.find((p) => p.index === selected) ?? null

  async function mutate(entry: PackageEntryView, action: 'enable' | 'disable' | 'remove') {
    await runWrite(`${actionLabel(action)} ${entry.source}`, async () => {
      await api.mutatePluginEntry(home, action, entry.index, listing!.revision)
      await reload()
    })
  }

  const selectedBuiltinEntry = builtin?.extensions.find((entry) => entry.id === selectedBuiltin) ?? null

  async function installBuiltin(entry: BuiltinExtensionEntry) {
    await runWrite(`安装 ${entry.fileName}`, async () => {
      await api.installBuiltinExtension(home, entry.id)
      await reloadBuiltin()
    })
  }

  async function uninstallBuiltin(entry: BuiltinExtensionEntry) {
    await runWrite(`卸载 ${entry.fileName}（重启 pi 后生效）`, async () => {
      await api.uninstallBuiltinExtension(home, entry.id)
      await reloadBuiltin()
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
              mark={entry.disabled ? 'off' : 'ok'}
              title={entry.source || '（无 source）'}
              sub={`${entry.kind === 'plain' ? 'string 形式（启用）' : 'object 形式'}${entry.autoload ? ' · autoload' : ''}`}
              badges={entry.hasFilters ? <span className="badge warn">filters</span> : undefined}
              onClick={() => setSelected(entry.index)}
            />
          ))}
          {listing.packages.length === 0 ? (
            <p className="mono-dim">settings.json 没有 packages 条目；用 pi CLI 安装后这里会出现。</p>
          ) : null}

          {builtin && builtin.extensions.length > 0 ? (
            <>
              <div className="builtin-head">
                <span>内置扩展</span>
                {builtin.heartbeatDetected ? <span className="builtin-head-state is-on">心跳已启用</span> : null}
              </div>
              {builtin.extensions.map((entry) => (
                <SectionListItem
                  key={entry.id}
                  active={entry.id === selectedBuiltin}
                  mark={entry.installed ? 'ok' : entry.sourceAvailable ? 'warn' : 'off'}
                  title={entry.fileName}
                  sub={entry.installed ? '已安装' : entry.sourceAvailable ? '未安装 · 可一键安装' : '源文件缺失'}
                  onClick={() => setSelectedBuiltin(entry.id)}
                />
              ))}
            </>
          ) : null}
        </>
      }
      footer={
        <SectionFooterNote note="npm 包用 pi CLI 安装与升级，这里只切换启用状态与移除条目；内置扩展由本服务自带，一键安装进 home。" />
      }
      detail={
        selectedBuiltinEntry ? (
          <BuiltinDetail
            key={selectedBuiltinEntry.id}
            home={home}
            entry={selectedBuiltinEntry}
            onInstall={() => void installBuiltin(selectedBuiltinEntry)}
            onUninstall={() => void uninstallBuiltin(selectedBuiltinEntry)}
          />
        ) : selectedEntry ? (
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
                  void confirmDialog({
                    title: `从 settings.json 移除 ${selectedEntry.source}？`,
                    body: '只移除清单条目，npm/ 目录里的文件不会删除。',
                    confirmLabel: '移除',
                    danger: true,
                  }).then((ok) => {
                    if (ok) void mutate(selectedEntry, 'remove')
                  })
                }}
              >
                移除条目
              </button>
            </div>
          </div>
        ) : (
          <EmptyState title="没有选中的插件" hint="在左侧选择一个条目，或安装一个内置扩展。" />
        )
      }
    />
  )
}

/** 内置扩展详情：状态、安装路径与一键安装/卸载。 */
function BuiltinDetail({
  entry,
  onInstall,
  onUninstall,
}: {
  home: string
  entry: BuiltinExtensionEntry
  onInstall: () => void
  onUninstall: () => void
}) {
  return (
    <div className="detail-sheet is-plain">
      <SectionDetailHead
        title={entry.fileName}
        meta={entry.installedPath ? `已安装 · ${entry.installedPath}` : '未安装'}
      />
      <p className="mono-dim">{entry.description}</p>
      {!entry.sourceAvailable ? (
        <p className="section-warn">部署目录里找不到源文件，无法安装；请检查本服务的部署完整性。</p>
      ) : null}
      {entry.installed ? (
        <p className="mono-dim">
          已装好的扩展由 pi 在会话启动时加载；刚安装的要在新会话或 /reload 后生效。
        </p>
      ) : null}
      <div className="field-row">
        {entry.installed ? (
          <button type="button" className="btn" onClick={onInstall}>
            重新安装（覆盖）
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!entry.sourceAvailable}
            onClick={onInstall}
          >
            一键安装
          </button>
        )}
        {entry.installed ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              void confirmDialog({
                title: `卸载 ${entry.fileName}？`,
                body: '会话视图的运行态功能会随之关闭。',
                confirmLabel: '卸载',
                danger: true,
              }).then((ok) => {
                if (ok) onUninstall()
              })
            }}
          >
            卸载
          </button>
        ) : null}
      </div>
    </div>
  )
}

function actionLabel(action: 'enable' | 'disable' | 'remove'): string {
  return action === 'enable' ? '启用' : action === 'disable' ? '禁用' : '移除'
}
