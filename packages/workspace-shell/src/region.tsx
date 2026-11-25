import type { ReactNode } from 'react'
import type { Selection, WorkspaceModule, WorkspaceView } from './contracts'
import './shell.css'

const ACTIONS_SIZE = 260

/** 按选中找视图：先看 views 注册，再看模块自带 WorkspaceView。 */
function findWorkspaceView(
  modules: WorkspaceModule[],
  views: WorkspaceView[],
  selection: Selection | null,
): ReactNode {
  if (!selection) return null
  for (const view of views) {
    if (view.kind !== selection.kind) continue
    const View = view.Component
    return <View selection={selection} />
  }
  for (const module of modules) {
    const kind = module.selection
    if (!kind || kind.kind !== selection.kind || !kind.WorkspaceView) continue
    const View = kind.WorkspaceView
    return <View selection={selection} />
  }
  return null
}

function summaryFor(modules: WorkspaceModule[], selection: Selection): string | null {
  const module = modules.find((candidate) => candidate.selection?.kind === selection.kind)
  return module?.selection?.summary(selection) ?? null
}

export { ACTIONS_SIZE, findWorkspaceView, summaryFor }
