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

/** 左侧分区导航。 */
export function Sidebar({
  active,
  onSelect,
}: {
  active: SectionId
  onSelect: (id: SectionId) => void
}) {
  return (
    <nav className="config-sidebar" aria-label="配置分区">
      <div className="config-sidebar-heading">配置</div>
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
