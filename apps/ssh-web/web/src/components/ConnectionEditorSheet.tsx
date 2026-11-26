import { useEffect, useState } from 'react'
import type { ConnectionInput } from '../api/types'
import { useSshStore } from '../ssh-context'

const EMPTY_FORM: ConnectionInput = { name: '', command: '' }

/**
 * 底部连接编辑表单：只有名称和 ssh 命令两个字段，认证细节交给 ssh 自身（config、agent、密钥）。
 * 保存前先自检能否连上（只测传输层与认证，不读 tmux）；失败时给出 OpenSSH 的原因，
 * 由用户决定是否仍然保存（离线机器、需要交互密码的连接）。
 */
export function ConnectionEditorSheet() {
  const editor = useSshStore((state) => state.editor)
  const setEditor = useSshStore((state) => state.setEditor)
  const saveConnection = useSshStore((state) => state.saveConnection)
  const verifyConnection = useSshStore((state) => state.verifyConnection)
  const setNotice = useSshStore((state) => state.setNotice)

  const [form, setForm] = useState<ConnectionInput>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  const editing = editor?.kind === 'edit' ? editor.connection : null

  useEffect(() => {
    if (!editor) return
    setForm(
      editor.kind === 'edit'
        ? { name: editor.connection.name, command: editor.connection.command }
        : EMPTY_FORM,
    )
    setVerifyError(null)
    setChecking(false)
  }, [editor])

  if (!editor) return null

  const patch = (changes: Partial<ConnectionInput>) => {
    if (changes.command !== undefined) setVerifyError(null)
    setForm((form) => ({ ...form, ...changes }))
  }

  /** 校验表单，返回可提交的输入；不合法时只提示，返回 null。 */
  const readInput = (): ConnectionInput | null => {
    const name = form.name.trim()
    const command = form.command.trim()
    if (!name || !command) {
      setNotice('名称和 ssh 命令为必填项。')
      return null
    }
    if (command.split(/\s+/)[0] !== 'ssh') {
      setNotice('命令需要以 ssh 开头，例如 ssh -p 2222 user@host。')
      return null
    }
    return { name, command }
  }

  const submit = async (force = false) => {
    const input = readInput()
    if (!input) return
    // 编辑时命令没变就不重复自检：只改名字的场景不该再等一轮 ssh。
    const commandChanged = editor.kind === 'new' || editing?.command !== input.command
    if (!force && commandChanged) {
      setChecking(true)
      setVerifyError(null)
      try {
        const result = await verifyConnection(input.command)
        if (!result.ok) {
          setVerifyError(result.detail ?? '连接失败')
          return
        }
      } catch (error) {
        setVerifyError(error instanceof Error ? error.message : String(error))
        return
      } finally {
        setChecking(false)
      }
    }
    setSaving(true)
    try {
      await saveConnection(editor, input)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="ssh-sheet">
      <div className="ssh-sheet-head">
        <span className="ssh-sheet-title">{editing ? `Edit "${editing.name}"` : 'New connection'}</span>
        <div className="ssh-sheet-actions">
          <button type="button" className="ssh-btn" onClick={() => setEditor(null)} disabled={saving}>
            Close
          </button>
          <button
            type="button"
            className="ssh-btn ssh-btn-primary"
            onClick={() => void submit()}
            disabled={saving || checking}
          >
            {checking ? 'Checking…' : saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div className="ssh-sheet-body">
        <label className="ssh-field">
          <span className="ssh-field-label">Name</span>
          <input
            className="ssh-input"
            value={form.name}
            onChange={(event) => patch({ name: event.target.value })}
            autoFocus
          />
        </label>
        <label className="ssh-field ssh-field-grow">
          <span className="ssh-field-label">SSH command（完整 ssh 命令，支持 config 别名、-p、-i、-J 等）</span>
          <input
            className="ssh-input"
            placeholder="ssh user@host"
            value={form.command}
            onChange={(event) => patch({ command: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </label>
      </div>
      {verifyError ? (
        <div className="ssh-sheet-verify">
          <span className="ssh-sheet-verify-text">{verifyError}</span>
          <button
            type="button"
            className="ssh-btn"
            onClick={() => void submit(true)}
            disabled={saving || checking}
          >
            Still save
          </button>
        </div>
      ) : null}
    </div>
  )
}
