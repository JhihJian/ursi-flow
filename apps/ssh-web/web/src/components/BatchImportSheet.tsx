import { useEffect, useMemo, useState } from 'react'
import type { ConnectionInput, DiscoveredHost, ImportConnectionsResponse } from '../api/types'
import { useSshController, useSshStore } from '../ssh-context'

/** 弹框里一行的本地编辑态：勾选 + 可改的名称与命令。 */
interface HostDraft {
  checked: boolean
  name: string
  command: string
}

/** ssh config 的 Host 别名转连接名：保留常见分隔符，其余非法字符换连字符。 */
function sanitizeName(host: string): string {
  return host.trim().replace(/[^\p{L}\p{N} _\-:.]/gu, '-')
}

/** 单台发现的主机转默认命令：非默认端口就显式带 -p。 */
function draftOf(host: DiscoveredHost): HostDraft {
  const portFlag = host.port ? ` -p ${host.port}` : ''
  return {
    checked: false,
    name: sanitizeName(host.host),
    command: `ssh${portFlag} ${host.host}`,
  }
}

/**
 * 从本机 ssh config 批量导入连接的临时弹框。
 * 服务端发现主机（ssh -G 解析 user/port），这里按行勾选，名称与命令可改，
 * 提交后展示导入结果：成功计数在前，单条失败原因紧跟其后。
 */
export function BatchImportSheet() {
  const { api } = useSshController()
  const open = useSshStore((state) => state.batchImportOpen)
  const setBatchImportOpen = useSshStore((state) => state.setBatchImportOpen)
  const importConnections = useSshStore((state) => state.importConnections)
  const setNotice = useSshStore((state) => state.setNotice)

  const [hosts, setHosts] = useState<DiscoveredHost[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<HostDraft[]>([])
  const [result, setResult] = useState<ImportConnectionsResponse | null>(null)
  const [importing, setImporting] = useState(false)
  const [requestSeq, setRequestSeq] = useState(0)

  const selected = drafts.filter((draft) => draft.checked).length
  const allSelected = drafts.length > 0 && selected === drafts.length

  useEffect(() => {
    if (!open) return
    const seq = requestSeq + 1
    setRequestSeq(seq)
    setHosts(null)
    setLoadError(null)
    setDrafts([])
    setResult(null)
    setImporting(false)
    ;(async () => {
      try {
        const response = await api.discoverSshHosts()
        if (requestSeq !== seq - 1) return
        setHosts(response.hosts)
        setDrafts(response.hosts.map(draftOf))
      } catch (error) {
        if (requestSeq !== seq - 1) return
        setLoadError(error instanceof Error ? error.message : String(error))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 关闭并清编辑态：下次打开重新发现，避免展示过期列表。 */
  const close = (): void => {
    if (importing) return
    setBatchImportOpen(false)
    setDrafts([])
    setResult(null)
    setLoadError(null)
    setHosts(null)
  }

  const patch = (index: number, changes: Partial<HostDraft>): void => {
    setDrafts((previous) =>
      previous.map((draft, position) => (position === index ? { ...draft, ...changes } : draft)),
    )
  }

  const toggleAll = (): void => {
    const next = !allSelected
    setDrafts((previous) => previous.map((draft) => ({ ...draft, checked: next })))
  }

  const submit = async (): Promise<void> => {
    if (selected === 0) {
      setNotice('先勾选要导入的主机。')
      return
    }
    setImporting(true)
    try {
      const inputs: ConnectionInput[] = drafts
        .filter((draft) => draft.checked)
        .map((draft) => ({ name: draft.name.trim(), command: draft.command.trim() }))
      const response = await importConnections(inputs)
      setResult(response)
      // 成功导入的行移出列表，剩下的留在框里便于改错重试。
      setDrafts((previous) => previous.filter((draft) => !draft.checked))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  const summary = useMemo(() => {
    if (result === null) return null
    const failedText =
      result.failed.length > 0
        ? `；失败 ${result.failed.length} 条：${result.failed
            .map((failure) => `${failure.name}（${failure.reason}）`)
            .join('；')}`
        : ''
    return `导入 ${result.imported.length} 条${failedText}`
  }, [result])

  if (!open) return null

  return (
    <div className="ssh-sheet">
      <div className="ssh-sheet-head">
        <span className="ssh-sheet-title">Import from ssh config</span>
        <div className="ssh-sheet-actions">
          <button type="button" className="ssh-btn" onClick={close} disabled={importing}>
            Close
          </button>
          <button
            type="button"
            className="ssh-btn ssh-btn-primary"
            onClick={() => void submit()}
            disabled={importing || selected === 0}
            title="把勾选的主机各建为一条连接"
          >
            {importing ? 'Importing…' : `Import ${selected}`}
          </button>
        </div>
      </div>
      <div className="ssh-import-list">
        {loadError ? (
          <div className="ssh-import-note ssh-import-note-error">{loadError}</div>
        ) : hosts === null ? (
          <div className="ssh-import-note">正在读取 ssh config…</div>
        ) : drafts.length === 0 ? (
          <div className="ssh-import-note">
            {result
              ? summary
              : 'ssh config 里没有可导入的主机（没有具体的 Host 别名）。'}
          </div>
        ) : (
          <>
            <div className="ssh-import-toolbar">
              <label className="ssh-import-check">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                全选（{drafts.length}）
              </label>
            </div>
            <ul className="ssh-import-rows">
              {drafts.map((draft, index) => (
                <li key={`${draft.name}-${index}`} className="ssh-import-row">
                  <label className="ssh-import-check">
                    <input
                      type="checkbox"
                      checked={draft.checked}
                      onChange={(event) => patch(index, { checked: event.target.checked })}
                    />
                  </label>
                  <input
                    className="ssh-input ssh-import-name"
                    value={draft.name}
                    aria-label="连接名"
                    onChange={(event) => patch(index, { name: event.target.value })}
                  />
                  <input
                    className="ssh-input ssh-import-command"
                    value={draft.command}
                    aria-label="ssh 命令"
                    onChange={(event) => patch(index, { command: event.target.value })}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {result !== null && drafts.length > 0 ? (
        <div className="ssh-import-note ssh-import-result">{summary}</div>
      ) : null}
    </div>
  )
}
