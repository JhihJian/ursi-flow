import { useAppStore } from '../store/app-store'

/** 顶栏：当前 pi home 路径展示。切换与新增统一在左侧 Pi home 列表。 */
export function HomeBar() {
  const homePath = useAppStore((s) => s.homePath)
  const homeValid = useAppStore((s) => s.homeValid)
  const homeChecking = useAppStore((s) => s.homeChecking)

  return (
    <header className="home-bar">
      <span className="home-bar-title">Pi Manager</span>
      <span className={`home-bar-path${homeValid === false ? ' invalid' : ''}`} title={homePath}>
        {homeChecking ? '校验中…' : homePath || '未设置 pi home'}
        {homeValid === false ? '（不是有效的 pi home）' : ''}
      </span>
    </header>
  )
}
