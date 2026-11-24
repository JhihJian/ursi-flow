import { useEffect, useState } from 'react'
import type { AuthType, ConnectionInput } from '../api/types'
import { useSshStore } from '../store/ssh-store'

const EMPTY_FORM: ConnectionInput = {
  name: '',
  host: '',
  port: 22,
  username: '',
  auth_type: 'password',
  password: '',
  key_path: '',
  key_passphrase: '',
}

/** 底部连接编辑表单。编辑已有连接时 password 留空表示保持原密码。 */
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
    if (editor.kind === 'edit') {
      const c = editor.connection
      setForm({
        name: c.name,
        host: c.host,
        port: c.port,
        username: c.username,
        auth_type: c.auth_type,
        password: '',
        key_path: c.key_path ?? '',
        key_passphrase: c.key_passphrase ?? '',
      })
    } else {
      setForm(EMPTY_FORM)
    }
  }, [editor])

  if (!editor) return null

  const patch = (changes: Partial<ConnectionInput>) => setForm((form) => ({ ...form, ...changes }))

  const submit = async () => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setNotice('名称、主机、用户名为必填项。')
      return
    }
    setSaving(true)
    try {
      const target = editor
      await saveConnection(target, {
        ...form,
        port: Number(form.port) || 22,
        name: form.name.trim(),
        host: form.host.trim(),
        username: form.username.trim(),
      })
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
          <label className="form-group">
            <span className="form-label">Host</span>
            <input
              className="form-input"
              value={form.host}
              onChange={(event) => patch({ host: event.target.value })}
            />
          </label>
          <label className="form-group form-narrow">
            <span className="form-label">Port</span>
            <input
              className="form-input"
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(event) => patch({ port: Number(event.target.value) })}
            />
          </label>
          <label className="form-group">
            <span className="form-label">Username</span>
            <input
              className="form-input"
              value={form.username}
              onChange={(event) => patch({ username: event.target.value })}
            />
          </label>
        </div>
        <div className="form-row">
          <label className="form-group form-narrow">
            <span className="form-label">Auth type</span>
            <select
              className="form-select"
              value={form.auth_type}
              onChange={(event) => patch({ auth_type: event.target.value as AuthType })}
            >
              <option value="password">password</option>
              <option value="key">key</option>
            </select>
          </label>
          {form.auth_type === 'password' ? (
            <label className="form-group">
              <span className="form-label">{editing ? 'Password（留空保持不变）' : 'Password'}</span>
              <input
                className="form-input"
                type="password"
                value={form.password}
                onChange={(event) => patch({ password: event.target.value })}
              />
            </label>
          ) : (
            <>
              <label className="form-group">
                <span className="form-label">Key path（服务器上的绝对路径）</span>
                <input
                  className="form-input"
                  value={form.key_path}
                  onChange={(event) => patch({ key_path: event.target.value })}
                />
              </label>
              <label className="form-group">
                <span className="form-label">Key passphrase</span>
                <input
                  className="form-input"
                  type="password"
                  value={form.key_passphrase}
                  onChange={(event) => patch({ key_passphrase: event.target.value })}
                />
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
