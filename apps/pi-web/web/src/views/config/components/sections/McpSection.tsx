import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { McpListing, McpServerView } from '../../api/types'
import { describeError, useAppStore } from '../../../../pi-store'
import { SectionDetailHead, SectionFooterNote, SectionListHead, SectionListItem, SectionSplit } from '../layout'
import { EmptyState, ErrorBanner, Field, Loading, Switch, confirmDialog } from '../ui'

/**
 * MCP（mcp.json）：server 列表 + JSON 详情编辑，合并写回语义同 models。
 * env/headers 里字面量密钥显示为掩码，原样提交会被服务端还原；
 * ${VAR} 引用与 !command 值原样保留并打标（不展开、不执行）。
 */

export function McpSection({ home }: { home: string }) {
  const [listing, setListing] = useState<McpListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const runWrite = useAppStore((s) => s.runWrite)

  const reload = useCallback(async () => {
    try {
      const data = await api.getMcp(home)
      setListing(data)
      setError(null)
      setCreating(false)
      setSelected((current) =>
        current && data.servers.some((s) => s.name === current) ? current : (data.servers[0]?.name ?? null),
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

  const selectedServer = listing.servers.find((s) => s.name === selected) ?? null

  async function saveOne(name: string, entry: Record<string, unknown> | null, label: string) {
    return runWrite(label, async () => {
      await api.putMcpServers(home, { [name]: entry }, listing!.revision)
      await reload()
    })
  }

  async function patchState(
    server: McpServerView,
    patch: { enabled?: boolean; exposure?: McpServerView['exposure'] },
    label: string,
  ) {
    await runWrite(label, async () => {
      await api.putMcpServerState(home, server.name, patch, listing!.revision)
      await reload()
    })
  }

  return (
    <SectionSplit
      list={
        <>
          <SectionListHead
            title="MCP"
            actions={
              <button type="button" className="btn small" onClick={() => setCreating(true)}>
                新增
              </button>
            }
          />
          {listing.servers.map((server) => (
            <SectionListItem
              key={server.name}
              active={server.name === selected && !creating}
              mark={server.enabled ? 'ok' : 'off'}
              title={server.name}
              sub={server.maskedFields.length > 0 ? `掩码字段：${server.maskedFields.join('、')}` : server.exposure === 'codemode' ? describeTransport(server) : `exposure: ${server.exposure}`}
              badges={<span className="badge">{server.entry && typeof (server.entry as { url?: unknown }).url === 'string' ? 'http' : 'stdio'}</span>}
              onClick={() => {
                setCreating(false)
                setSelected(server.name)
              }}
            />
          ))}
          {listing.servers.length === 0 ? (
            <p className="mono-dim">mcp.json 没有 server{listing.exists ? '' : '（文件尚不存在，保存后创建）'}。</p>
          ) : null}
        </>
      }
      footer={
        <SectionFooterNote note="只管理全局 mcp.json；项目级 .pi/mcp.json 请直接编辑。运行状态与工具发现由 pi 会话负责。" />
      }
      detail={
        creating ? (
          <ServerEditor
          key="__new__"
          server={{
            name: '',
            entry: { command: '', args: [] },
            maskedFields: [],
            varRefs: [],
            commandValues: [],
            hiddenChars: [],
            transport: 'stdio',
            enabled: true,
            exposure: 'codemode',
            cwd: null,
            envNames: [],
            headerNames: [],
          }}
          isNew
          onSave={(name, entry) => saveOne(name, entry, `新增 server ${name}`)}
          onCancel={() => setCreating(false)}
        />
      ) : selectedServer ? (
        <ServerEditor
          key={selectedServer.name}
          server={selectedServer}
          isNew={false}
          onSave={(name, entry) => saveOne(name, entry, `保存 server ${name}`)}
          onDelete={() => saveOne(selectedServer.name, null, `删除 server ${selectedServer.name}`)}
          onPatchState={(patch, label) => patchState(selectedServer, patch, label)}
        />
      ) : (
        <EmptyState title="没有选中的 server" hint="在左侧选择一个 server，或点「新增」。" />
      )}
    />
  )
}

function describeTransport(server: McpServerView): string {
  const entry = server.entry as { url?: unknown; command?: unknown }
  if (typeof entry.url === 'string') return `http · ${entry.url}`
  if (typeof entry.command === 'string') return `stdio · ${entry.command}`
  return '（传输方式未标注）'
}

function ServerTarget({ server }: { server: McpServerView }) {
  const entry = server.entry as { url?: unknown; command?: unknown; args?: unknown }
  const args = Array.isArray(entry.args)
    ? entry.args.filter((item): item is string => typeof item === 'string')
    : []
  if (typeof entry.url === 'string') return <code className="mcp-target">{entry.url}</code>
  if (typeof entry.command === 'string') {
    return <code className="mcp-target">{[entry.command, ...args].join(' ')}</code>
  }
  return <span className="mono-dim">（未标注传输方式）</span>
}

function ServerEditor({
  server,
  isNew,
  onSave,
  onDelete,
  onCancel,
  onPatchState,
}: {
  server: McpServerView
  isNew: boolean
  onSave: (name: string, entry: Record<string, unknown>) => Promise<boolean>
  onDelete?: () => Promise<boolean>
  onCancel?: () => void
  onPatchState?: (
    patch: { enabled?: boolean; exposure?: McpServerView['exposure'] },
    label: string,
  ) => Promise<void>
}) {
  const [name, setName] = useState(server.name)
  const [text, setText] = useState(() => JSON.stringify(server.entry, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const nameValid = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)

  function parseDraft(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('server 条目必须是 JSON 对象')
        return null
      }
      setJsonError(null)
      return parsed as Record<string, unknown>
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'JSON 解析失败')
      return null
    }
  }

  async function commit() {
    const entry = parseDraft()
    if (!entry || !nameValid) return
    await onSave(name, entry)
  }

  /**
   * 开关写的是同一个条目的 enabled/exposure：先把这两个键同步到本地草稿，
   * 否则下一次「保存」会用旧草稿把它们覆盖掉。
   */
  function applyStatePatch(
    patch: { enabled?: boolean; exposure?: McpServerView['exposure'] },
    label: string,
  ) {
    const entry = parseDraft()
    if (!entry || !onPatchState) return
    const next = { ...entry }
    if (patch.enabled !== undefined) {
      if (patch.enabled) delete next.enabled
      else next.enabled = false
    }
    if (patch.exposure !== undefined) {
      if (patch.exposure === 'codemode') delete next.exposure
      else next.exposure = patch.exposure
    }
    setText(JSON.stringify(next, null, 2))
    void onPatchState(patch, label)
  }

  return (
    <div className="detail-sheet is-plain">
      <SectionDetailHead
        title={isNew ? '新增 server' : server.name}
        meta="stdio：command/args/env · http：url/headers · 密钥字段显示掩码"
      />
      <div className="detail-form">
          {!isNew && onPatchState ? (
            <div className="detail-grid">
              <Field label="启用" hint="enabled: false 时 pi 不连接该 server；打开会删除该 key。">
                <Switch
                  pressed={server.enabled}
                  label={server.enabled ? '已启用' : '已停用'}
                  onChange={(next) =>
                    applyStatePatch({ enabled: next }, `${next ? '启用' : '停用'} server ${server.name}`)
                  }
                />
              </Field>
              <Field label="exposure" hint="codemode（默认）会删键；direct/deferred 写入条目。">
                <select
                  className="select"
                  value={server.exposure}
                  onChange={(e) =>
                    applyStatePatch(
                      { exposure: e.target.value as McpServerView['exposure'] },
                      `设置 ${server.name} 的 exposure`,
                    )
                  }
                >
                  <option value="codemode">codemode（默认）</option>
                  <option value="direct">direct</option>
                  <option value="deferred">deferred</option>
                </select>
              </Field>
            </div>
          ) : null}

          <div className="mcp-summary">
            <div className="mcp-summary-row">
              <span className="cell-sub">目标</span>
              <ServerTarget server={server} />
            </div>
            {server.cwd ? (
              <div className="mcp-summary-row">
                <span className="cell-sub">cwd</span>
                <span className="cell-title">{server.cwd}</span>
              </div>
            ) : null}
            {server.envNames.length > 0 ? (
              <div className="mcp-summary-row">
                <span className="cell-sub">env</span>
                <span className="cell-title">{server.envNames.join('、')}</span>
              </div>
            ) : null}
            {server.headerNames.length > 0 ? (
              <div className="mcp-summary-row">
                <span className="cell-sub">headers</span>
                <span className="cell-title">{server.headerNames.join('、')}</span>
              </div>
            ) : null}
          </div>

          {server.maskedFields.length > 0 ? (
            <p className="detail-hint">
              密钥已遮蔽：{server.maskedFields.join('、')}。原样保存会写回磁盘原文；改成新值则写新值。
            </p>
          ) : null}
          {server.hiddenChars.length > 0 ? (
            <p className="section-warn">
              这些字段含不可见字符（{server.hiddenChars.join('、')}），可能是显示欺骗，请核对原文。
            </p>
          ) : null}
          {server.varRefs.length > 0 ? (
            <p className="detail-hint">值引用了环境变量：{server.varRefs.join('、')}。引用原样保留，不展开。</p>
          ) : null}
          {server.commandValues.length > 0 ? (
            <p className="section-warn">
              !command 动态值：{server.commandValues.join('、')}。管理台不执行命令，仅在会话连接时由 pi 处理。
            </p>
          ) : null}
          <div className="detail-grid">
            <Field label="server 名">
              <input
                className="input"
                value={name}
                readOnly={!isNew}
                onChange={(e) => setName(e.target.value)}
                placeholder="如 fs-web"
              />
            </Field>
          </div>
          <Field label="条目 JSON">
            <textarea
              className="textarea code"
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />
            {jsonError ? <span className="field-hint">{jsonError}</span> : null}
          </Field>
          <div className="field-row">
            <button type="button" className="btn btn-primary" disabled={!nameValid} onClick={() => void commit()}>
              保存
            </button>
            {onDelete ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  void confirmDialog({ title: `删除 server ${server.name}？`, confirmLabel: '删除', danger: true }).then((ok) => {
                    if (ok) void onDelete()
                  })
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
          </div>
      </div>
    </div>
  )
}
