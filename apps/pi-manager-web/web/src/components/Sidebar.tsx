import { useAppStore } from '../store/app-store'
import type { HomeSummary } from '../api/types'

export type SectionId =
  | 'general'
  | 'providers'
  | 'models'
  | 'skills'
  | 'agents'
  | 'plugins'
  | 'mcp'

export const SECTIONS: Array<{ id: SectionId; label: string; icon: string }> = [
  { id: 'general', label: '常规', icon: '⚙' },
  { id: 'providers', label: '凭据', icon: '🔑' },
  { id: 'models', label: '自定义模型', icon: '🧠' },
  { id: 'skills', label: 'Skills', icon: '✦' },
  { id: 'agents', label: 'Subagent', icon: '☷' },
  { id: 'plugins', label: '插件', icon: '⬢' },
  { id: 'mcp', label: 'MCP', icon: '⇄' },
]

const SOURCE_LABEL: Record<HomeSummary['sources'][number], string> = {
  default: '默认',
  env: 'ENV',
  user: '本机',
  manual: '预设',
}

function summaryLine(home: HomeSummary): string {
  if (home.error) return home.error
  if (!home.valid) return '缺 settings.json'
  const parts = [`${home.skills} skill`, `${home.agents} agent`, `${home.mcpServers} mcp`]
  if (home.packages > 0) parts.push(`${home.packages} 插件`)
  return parts.join(' · ')
}

/** 左侧导航：已知 pi home 预设 + 配置分区。 */
export function Sidebar({
  active,
  onSelect,
}: {
  active: SectionId
  onSelect: (id: SectionId) => void
}) {
  const homes = useAppStore((s) => s.homes)
  const homesLoading = useAppStore((s) => s.homesLoading)
  const homePath = useAppStore((s) => s.homePath)
  const presets = useAppStore((s) => s.presets)
  const confirmHome = useAppStore((s) => s.confirmHome)
  const addPreset = useAppStore((s) => s.addPreset)
  const removePreset = useAppStore((s) => s.removePreset)
  const refreshHomes = useAppStore((s) => s.refreshHomes)

  // 只有当前 home 不在已知列表里时才需要登记（默认、env、同机其他用户已自动列出）。
  const alreadyKnown = homes.some((h) => h.path === homePath)
  const canRegister = Boolean(homePath) && !alreadyKnown

  return (
    <nav className="config-sidebar" aria-label="pi home 与配置分区">
      <div className="config-sidebar-head">
        <span className="config-sidebar-heading">Pi 预设</span>
        {canRegister ? (
          <button
            type="button"
            className="rail-toggle"
            title={`把 ${homePath} 登记为预设`}
            onClick={() => void addPreset(homePath)}
          >
            +
          </button>
        ) : (
          <button
            type="button"
            className="rail-toggle"
            title="重新扫描已知 pi home"
            onClick={() => void refreshHomes()}
          >
            ↻
          </button>
        )}
      </div>
      <ul className="preset-list">
        {homes.map((home) => {
          const isCurrent = home.path === homePath
          const custom = presets.find((p) => p.path === home.path)
          return (
            <li key={home.path}>
              <div
                className={`preset-item${isCurrent ? ' active' : ''}${home.valid ? '' : ' invalid'}`}
                title={`${home.path}\n${summaryLine(home)}`}
              >
                <button
                  type="button"
                  className="preset-main"
                  aria-current={isCurrent}
                  onClick={() => void confirmHome(home.path)}
                >
                  <span className="preset-name">
                    {custom?.label ?? home.label}
                    <span className="preset-source">{home.sources.map((s) => SOURCE_LABEL[s]).join('/')}</span>
                  </span>
                  <span className="preset-sub">{summaryLine(home)}</span>
                </button>
                {home.sources.includes('manual') ? (
                  <button
                    type="button"
                    className="preset-remove"
                    title="从预设里移除（不删除目录）"
                    onClick={() => {
                      if (window.confirm(`从预设列表移除 ${custom?.label ?? home.label}？目录本身不会删除。`)) {
                        void removePreset(home.path)
                      }
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </li>
          )
        })}
        {homes.length === 0 ? (
          <li className="preset-empty">{homesLoading ? '扫描中…' : '没有发现 pi home'}</li>
        ) : null}
      </ul>

      <div className="config-sidebar-head config-sidebar-head-sections">
        <span className="config-sidebar-heading">配置</span>
      </div>
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          className="sidebar-item"
          aria-current={section.id === active}
          onClick={() => onSelect(section.id)}
        >
          <span className="sidebar-item-icon" aria-hidden>
            {section.icon}
          </span>
          <span className="sidebar-item-label">{section.label}</span>
        </button>
      ))}
    </nav>
  )
}
