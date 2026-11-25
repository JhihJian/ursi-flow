import { useEffect, useState } from 'react'
import type { ConnectionInput } from '../api/types'
import { useSshStore } from '../store/ssh-store'

const EMPTY_FORM: ConnectionInput = { name: '', command: '' }

/** 底部连接编辑表单：只有名称和 ssh 命令两个字段，认证细节交给 ssh 自身（config、agent、密钥）。 */
export function ConnectionEditorSheet() {
  const editor = useSshStore((state) => state.editor)
  const setEditor = useSshStore((state) => state.setEditor)
  const saveConnection = useSshStore((state) => state.saveConnection)
  const setNotice = useSshStore((state) => state.setNotice)

  const [form, setForm] = useState<ConnectionInput>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const editing = editor?.kind === 'edit' ? editor.connection : null

  useEffect(() => {
    if (!editor) return
    setForm(
      editor.kind === 'edit'
        ? { name: editor.connection.name, command: editor.connection.command }
        : EMPTY_FORM,
    )
  }, [editor])

  if (!editor) return null

  const patch = (changes: Partial<ConnectionInput>) => setForm((form) => ({ ...form, ...changes }))

  const submit = async () => {
    const name = form.name.trim()
    const command = form.command.trim()
    if (!name || !command) {
      setNotice('名称和 ssh 命令为必填项。')
      return
    }
    if (!command.split(/\s+/)[0].startsWith('ssh')) {
      setNotice('命令需要以 ssh 开头，例如 ssh -p 2222 user@host。')
      return
    }
    setSaving(true)
    try {
      await saveConnection(editor, { name, command })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="detail-sheet connection-sheet">
      <div className="detail-heading">
        <span className="detail-title-static">{editing ? `Edit "${editing.name}"` : 'New connection'}</span>
        <div className="detail-actions">
          <button type="button" className="btn" onClick={() => setEditor(null)} disabled={saving}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div className="detail-body">
        <div className="form-row">
          <label className="form-group">
            <span className="form-label">Name</span>
            <input
              className="form-input"
              value={form.name}
              onChange={(event) => patch({ name: event.target.value })}
              autoFocus
            />
          </label>
          <label className="form-group form-grow">
            <span className="form-label">SSH command（完整 ssh 命令，支持 config 别名、-p、-i、-J 等）</span>
            <input
              className="form-input"
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
      </div>
    </div>
  )
}
