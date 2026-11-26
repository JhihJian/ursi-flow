import type { ComponentType, ReactNode } from 'react'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { useActivation, usePi, type PiView } from './pi-context'

/**
 * 工作区：按活动视图渲染。视图挂载后就保留（切回来不丢滚动与草稿），
 * 但只有第一次激活时才挂载，避免打开工作台就扫描目录、连事件流。
 */

type ViewModule = WorkspaceModule

const ORDER: PiView[] = ['chat', 'sessions', 'config']

export function PiWorkspace({
  config,
  sessions,
  chat,
}: {
  config: ViewModule
  sessions: ViewModule
  chat: ViewModule
}): ReactNode {
  const { view } = usePi()
  const modules: Record<PiView, ViewModule> = { chat, sessions, config }

  return (
    <div className="pi-switch-workspace">
      {ORDER.map((id) => (
        <ViewSurface key={id} id={id} module={modules[id]} active={view === id} />
      ))}
    </div>
  )
}

function ViewSurface({ id, module, active }: { id: PiView; module: ViewModule; active: boolean }) {
  const seen = useActivation(active)
  if (!seen) return null
  const Workspace = module.Workspace as ComponentType
  return (
    <div className={`pi-switch-surface${active ? '' : ' is-hidden'}`} data-view={id} aria-hidden={!active}>
      <Workspace />
    </div>
  )
}
