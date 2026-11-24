import { ArrowUpRight, GitFork } from 'lucide-react'
import type { PluginContext, PortalContext } from '../portal-contract'

function ProjectLinks({ project }: PortalContext) {
  return <>
    <h2>项目链接</h2>
    {project.repository
      ? <a className="side-link" href={project.repository}><GitFork aria-hidden="true" size={17} />项目仓库<ArrowUpRight aria-hidden="true" size={15} /></a>
      : <p className="muted">未配置仓库地址</p>}
  </>
}

export function activate({ slots }: PluginContext) {
  slots.register('home.aside', { id: 'project-links', Component: ProjectLinks })
}
