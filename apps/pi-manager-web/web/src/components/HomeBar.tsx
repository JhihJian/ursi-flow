import { useState } from 'react'
import { useAppStore } from '../store/app-store'

/** 顶栏：pi home 路径展示与行内切换。 */
export function HomeBar() {
  const homePath = useAppStore((s) => s.homePath)
  const homeValid = useAppStore((s) => s.homeValid)
  const homeChecking = useAppStore((s) => s.homeChecking)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function startEdit() {
    setDraft(homePath)
    setEditing(true)
  }

  async function submit() {
    setEditing(false)
    if (draft.trim() && draft.trim() !== homePath) {
      await useAppStore.getState().confirmHome(draft)
    }
  }

  return (
    <header className="home-bar">
      <span className="home-bar-title">Pi Manager</span>
      {editing ? (
        <input
          className="filter-input"
          autoFocus
          value={draft}
          placeholder="pi home 路径，如 ~/.pi/agent"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={() => void submit()}
          style={{ flex: 1 }}
        />
      ) : (
        <button
          type="button"
          className={`home-bar-path${homeValid === false ? ' invalid' : ''}`}
          title="点击切换 home"
          onClick={startEdit}
        >
          {homeChecking ? '校验中…' : homePath || '未设置 pi home'}
          {homeValid === false ? '（不是有效的 pi home）' : ''}
        </button>
      )}
      <div className="home-bar-actions">
        <button type="button" className="btn btn-sm small" onClick={startEdit}>
          切换 home
        </button>
      </div>
    </header>
  )
}
