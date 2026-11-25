import { useEffect, useState } from 'react'
import { useAppStore } from '../store/app-store'

/** 顶栏：pi home 路径展示 + 切换 + 主题切换。 */
export function HomeBar() {
  const homePath = useAppStore((s) => s.homePath)
  const homeValid = useAppStore((s) => s.homeValid)
  const homeChecking = useAppStore((s) => s.homeChecking)
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

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
          className="input"
          autoFocus
          value={draft}
          placeholder="输入 pi home 绝对路径，如 ~/.pi/agent"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={() => void submit()}
          style={{ flex: 1 }}
        />
      ) : (
        <span className={`home-bar-path${homeValid === false ? ' invalid' : ''}`} title={homePath}>
          {homeChecking ? '校验中…' : homePath || '未设置 pi home'}
          {homeValid === false ? '（不是有效的 pi home）' : ''}
        </span>
      )}
      <div className="home-bar-actions">
        <button type="button" className="btn small" onClick={startEdit}>
          切换 home
        </button>
        <button type="button" className="btn small" onClick={toggleTheme}>
          {theme === 'dark' ? '亮色' : '暗色'}
        </button>
      </div>
    </header>
  )
}
