import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { McpListing, McpServerView } from '../../api/types'
import { describeError, useAppStore } from '../../store/app-store'
import { EmptyState, ErrorBanner, Field, Loading } from '../ui'

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
    <section className="section">
      <header className="section-head">
        <h1 className="section-title">MCP</h1>
        <div className="field-row">
          {!listing.exists ? <span className="section-desc">mcp.json 尚不存在，保存后创建</span> : null}
          <button type="button" className="btn small" onClick={() => setCreating(true)}>
            新增 server
          </button>
        </div>
      </header>
      {listing.servers.length > 0 ? (
        <table className="item-table">
          <thead>
            <tr>
              <th className="col-state">Mask</th>
              <th>Server</th>
              <th className="col-size">Transport</th>
            </tr>
          </thead>
          <tbody>
            {listing.servers.map((server) => (
              <tr
                key={server.name}
                className={server.name === selected && !creating ? 'is-selected' : undefined}
                onClick={() => {
                  setCreating(false)
                  setSelected(server.name)
                }}
              >
                <td className="col-state">
                  <span className={`state-mark${server.maskedFields.length > 0 ? ' off' : ''}`}>
                    {server.maskedFields.length > 0 ? `${server.maskedFields.length}` : '—'}
                  </span>
                </td>
                <td>
                  <div className="cell-title">{server.name}</div>
                  <div className="cell-sub">{server.maskedFields.length > 0 ? `掩码字段：${server.maskedFields.join('、')}` : ''}</div>
                </td>
                <td className="col-size">{describeTransport(server)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="mcp.json 没有 server" hint="点击右上角「新增 server」。" />
      )}
      <p className="mono-dim">
        本页只管理全局 mcp.json；项目级 .pi/mcp.json 请直接编辑项目文件。
        运行状态与工具发现由 pi 会话负责，管理台不 spawn 任何 server。
      </p>

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
      ) : null}
    </section>
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
    <div className="detail-sheet">
      <div className="detail-grip" aria-hidden />
      <div className="detail-body">
        <div className="detail-head">
          <h2 className="detail-title">{isNew ? '新增 server' : server.name}</h2>
          <span className="detail-meta">stdio：command/args/env · http：url/headers · 密钥字段显示掩码</span>
        </div>
        <div className="detail-form">
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
      </div>
    </div>
  )
}
