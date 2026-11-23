import { createContext, useContext } from 'react'
import { projectPath, projectsPath, type Project, type Workspace } from '@/shared/api/work-projects'
import type { Resource } from '@/shared/hooks/use-resource'
import type { Preferences } from './preferences'

export type ProjectView = 'map' | 'todo'
export const selectProjectPath = (view: ProjectView) => `${projectsPath}?view=${view}`

export function todoPath(id: string, state: { todoPath?: unknown } | null): string {
  const base = `${projectPath(id)}/todo`
  return typeof state?.todoPath === 'string' && state.todoPath.startsWith(`${base}?`) ? state.todoPath : base
}

type ProjectNavigation = {
  projectId: string | undefined
  projects: Resource<Project[]>
  workspace: Resource<Workspace | null>
  treeRevision: number
  refreshWorkspaces: () => void
  preferences: Preferences
  remember: (projectId: string, path: string) => void
  togglePinned: (id: string) => void
  isOpen: (id: string, defaultOpen: boolean) => boolean
  setOpen: (id: string, open: boolean) => void
}

export const ProjectNavigationContext = createContext<ProjectNavigation | null>(null)

export function useProjectNavigation() {
  const state = useContext(ProjectNavigationContext)
  if (!state) throw new Error('缺少工作项目导航上下文')
  return state
}
