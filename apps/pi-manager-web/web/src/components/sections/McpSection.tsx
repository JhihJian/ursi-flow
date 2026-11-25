import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { McpListing, McpServerView } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { Badge, EmptyState, ErrorBanner, Loading, Notice } from '../ui'

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

  return (
    <div className="split-view">
      <div className="split-list" role="listbox" aria-label="MCP server">
        {listing.servers.map((server) => (
          <button
            key={server.name}
            type="button"
            className="list-item"
            role="option"
            aria-current={server.name === selected && !creating}
            onClick={() => {
              setCreating(false)
              setSelected(server.name)
            }}
          >
            <span className="list-item-main">
              <div className="list-item-title">{server.name}</div>
              <div className="list-item-sub">{describeTransport(server)}</div>
            </span>
            <span className="list-item-badges">
              {server.maskedFields.length > 0 ? <Badge tone="warn">masked</Badge> : null}
            </span>
          </button>
        ))}
        {listing.servers.length === 0 ? (
          <EmptyState title="mcp.json 没有 server" hint="下方按钮新增。" />
        ) : null}
        <div style={{ marginTop: 'auto', paddingTop: 'var(--space-3)' }}>
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            新增 server
          </button>
        </div>
      </div>

      <div className="split-detail">
        <div className="split-detail-inner">
          {!listing.exists ? (
            <Notice>mcp.json 尚不存在，保存后创建。</Notice>
          ) : null}
          {creating ? (
            <ServerEditor
              key="__new__"
              server={{ name: '', entry: { command: '', args: [] }, maskedFields: [], varRefs: [], commandValues: [] }}
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
            />
          ) : (
            <EmptyState title="选择或新增 server" />
          )}
          <Notice>
            本页只管理全局 mcp.json；项目级 .pi/mcp.json 请直接编辑项目文件。
            运行状态与工具发现由 pi 会话负责，管理台不 spawn 任何 server。
          </Notice>
        </div>
      </div>
    </div>
  )
}

function describeTransport(server: McpServerView): string {
  const entry = server.entry as { type?: unknown; url?: unknown; command?: unknown }
  if (typeof entry.url === 'string') return `http · ${entry.url}`
  if (typeof entry.command === 'string') return `stdio · ${entry.command}`
  return typeof entry.type === 'string' ? entry.type : '（传输方式未标注）'
}

function ServerEditor({
  server,
  isNew,
  onSave,
  onDelete,
  onCancel,
}: {
  server: McpServerView
  isNew: boolean
  onSave: (name: string, entry: Record<string, unknown>) => Promise<boolean>
  onDelete?: () => Promise<boolean>
  onCancel?: () => void
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

  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <h2 className="settings-section-title">{isNew ? '新增 server' : server.name}</h2>
        <p className="settings-section-description">
          stdio：command/args/env；http：url/headers。env 与 headers 的字面量密钥显示为掩码。
        </p>
      </header>
      <div className="settings-section-body">
        {server.varRefs.length > 0 ? (
          <Notice>值引用了环境变量：{server.varRefs.join('、')}。引用原样保留，不展开。</Notice>
        ) : null}
        {server.commandValues.length > 0 ? (
          <Notice tone="warn">
            !command 动态值：{server.commandValues.join('、')}。管理台不执行命令，仅在会话连接时由 pi 处理。
          </Notice>
        ) : null}
        <label className="field">
          <span className="field-label">server 名</span>
          <input
            className="input"
            value={name}
            readOnly={!isNew}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 fs-web"
            style={{ maxWidth: 260 }}
          />
        </label>
        <label className="field">
          <span className="field-label">条目 JSON</span>
          <textarea
            className="textarea code"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          {jsonError ? (
            <span className="field-hint" style={{ color: 'var(--danger)' }}>{jsonError}</span>
          ) : null}
        </label>
        <div className="field-row">
          <button type="button" className="btn primary" disabled={!nameValid} onClick={() => void commit()}>
            保存
          </button>
          {onDelete ? (
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                if (window.confirm(`删除 server ${server.name}？`)) void onDelete()
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
    </section>
  )
}
