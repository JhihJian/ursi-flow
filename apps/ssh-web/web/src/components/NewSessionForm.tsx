import { useState } from 'react'
import { useSshStore } from '../ssh-context'

/** tmux 会话名：字母数字下划线连字符，1-64 字符，与服务端白名单一致。 */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 新建 tmux 会话表单：由标签栏 "+" 或右键菜单唤起，提交即在当前连接打开新标签。 */
export function NewSessionForm() {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const activeId = useSshStore((state) => state.activeId)
  const connections = useSshStore((state) => state.connections)
  const openTerminal = useSshStore((state) => state.openTerminal)
  const closeSessionForm = useSshStore((state) => state.closeSessionForm)

  const submitNew = () => {
    if (activeId === null) {
      closeSessionForm()
      return
    }
    const trimmed = name.trim()
    if (!NAME_PATTERN.test(trimmed)) {
      setError('会话名仅限字母、数字、下划线、连字符，最长 64 字符。')
      return
    }
    closeSessionForm()
    openTerminal(activeId, trimmed)
  }

  const connection = connections.find((item) => item.id === activeId)

  return (
    <div className="ssh-new-session">
      <input
        className="ssh-input"
        autoFocus
        placeholder={connection ? `在 ${connection.name} 新建会话` : '先选择一个连接'}
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submitNew()
          if (event.key === 'Escape') closeSessionForm()
        }}
      />
      {error ? <div className="ssh-tree-note ssh-error-note">{error}</div> : null}
      <div className="ssh-confirm-actions">
        <button type="button" className="ssh-btn ssh-btn-primary" onClick={submitNew}>
          打开
        </button>
        <button type="button" className="ssh-btn" onClick={closeSessionForm}>
          取消
        </button>
      </div>
    </div>
  )
}
