import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useLocation, useMatch } from 'react-router'
import { listProjects, readWorkspace } from '@/shared/api/work-projects'
import { useResource } from '@/shared/hooks/use-resource'
import { readPreferences, writePreferences } from './preferences'
import { ProjectNavigationContext } from './project-navigation'

export function ProjectNavigationProvider({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences)
  const projects = useResource(signal => signedIn ? listProjects(signal) : Promise.resolve([]), [])
  const routeProject = useMatch('/work-projects/:projectId/*')?.params.projectId
  const projectId = signedIn ? routeProject ?? projects.data.find(project => project.id === preferences.recent?.projectId)?.id : undefined
  const snapshot = useResource(signal => projectId ? readWorkspace(projectId, signal) : Promise.resolve(null), null, projectId ?? '')
  const workspace = { ...snapshot, data: snapshot.data?.project.id === projectId ? snapshot.data : null }
  const { pathname, search } = useLocation()
  const params = new URLSearchParams(search)
  const selection = JSON.stringify([projectId, pathname, params.get('focusCardId'), params.get('focusItemId'), params.get('itemId')])
  const [branches, setBranches] = useState<Record<string, { selection: string; open: boolean }>>({})
  const [treeRevision, setTreeRevision] = useState(0)

  function refreshWorkspaces() {
    snapshot.reload()
    setTreeRevision(revision => revision + 1)
  }

  useEffect(() => { writePreferences(preferences) }, [preferences])
  const remember = useCallback((projectId: string, path: string) => {
    setPreferences(current => current.recent?.path === path ? current : { ...current, recent: { projectId, path } })
  }, [])
  function togglePinned(id: string) {
    setPreferences(current => ({ ...current, pinned: current.pinned.includes(id) ? current.pinned.filter(pinned => pinned !== id) : [...current.pinned, id] }))
  }
  return <ProjectNavigationContext.Provider value={{
    projects, workspace, projectId, preferences, remember, togglePinned, treeRevision, refreshWorkspaces,
    // Keep manually expanded branches open; a new route reveals its selected nodes.
    isOpen: (id, defaultOpen) => branches[id]?.selection === selection ? branches[id].open : branches[id]?.open || defaultOpen,
    setOpen: (id, open) => setBranches(current => ({ ...current, [id]: { selection, open } })),
  }}>{children}</ProjectNavigationContext.Provider>
}
