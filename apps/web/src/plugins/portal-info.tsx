import type { PluginContext, PortalContext } from '../portal-contract'

function ProjectBadge({ project }: PortalContext) {
  return <span className="project-badge">{project.id}</span>
}

function PortalRevision({ revision }: PortalContext) {
  return <span>配置修订：<code>{revision}</code></span>
}

export function activate({ slots }: PluginContext) {
  slots.register('title', { id: 'project-badge', Component: ProjectBadge })
  slots.register('status', { id: 'revision', Component: PortalRevision })
}
