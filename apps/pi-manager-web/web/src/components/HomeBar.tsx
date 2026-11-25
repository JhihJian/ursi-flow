import { useAppStore } from '../store/app-store'

/**
 * 顶栏：当前 pi home 的名称与路径。
 * 切换与新增统一在左侧 Pi home 列表；这里只做状态展示。
 */
export function HomeBar() {
  const homePath = useAppStore((s) => s.homePath)
  const homes = useAppStore((s) => s.homes)
  const homeValid = useAppStore((s) => s.homeValid)
  const homeChecking = useAppStore((s) => s.homeChecking)
  const current = homes.find((h) => h.path === homePath)

  return (
    <header className="home-bar">
      <span className="home-bar-title">Pi Manager</span>
      <span className={`home-bar-home${homeValid === false ? ' invalid' : ''}`} title={homePath}>
        {homeChecking ? '校验中…' : null}
        {!homeChecking && current ? <span className="home-bar-name">{current.name}</span> : null}
        <span className="home-bar-path">{homePath || '未设置 pi home'}</span>
        {homeValid === false ? <span className="home-bar-flag">（不是有效的 pi home）</span> : null}
      </span>
    </header>
  )
}
