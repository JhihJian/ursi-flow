import { requestV2 } from '@/shared/http/client'
import { workItemPath, type WorkDraft, type WorkItem } from './work-items'

export type Named = { id: string; name: string }
export type Project = Named & { revision: number }
export type TaskCard = Named & { canvasId: string }
export type PlacedItem = { item: WorkItem; taskCardId: string; rank: number }
export type Relation = { id: string; canvasId: string | null; from: string; to: string }
export type Layout = { revision: number; positions: Record<string, { x: number; y: number }> }
export type Workspace = {
  project: Project; canvases: Named[]; taskCards: TaskCard[]; items: PlacedItem[]; relations: Relation[]
  layouts: { map: Layout; canvases: Record<string, Layout> }
}
export type Placement = { projectId: string; canvasId: string; taskCardId: string }
export type Command =
  | { type: 'createCanvas'; name: string }
  | { type: 'renameCanvas'; canvasId: string; name: string }
  | { type: 'deleteCanvas'; canvasId: string }
  | { type: 'createTaskCard'; canvasId: string; name: string }
  | { type: 'renameTaskCard'; taskCardId: string; name: string }
  | { type: 'deleteTaskCard'; taskCardId: string }
  | ({ type: 'createItem'; taskCardId: string } & Omit<WorkDraft, 'status'>)
  | { type: 'placeItem'; workItemId: string; taskCardId: string | null }
  | { type: 'reorderItems'; taskCardId: string; itemIds: string[] }
  | { type: 'createRelation'; canvasId: string | null; from: string; to: string }
  | { type: 'replaceRelation'; relationId: string; from: string; to: string }
  | { type: 'deleteRelation'; relationId: string }

export const projectsPath = '/work-projects'
export const projectPath = (id: string) => `${projectsPath}/${encodeURIComponent(id)}`
export const canvasPath = (id: string, canvasId: string) => `${projectPath(id)}/canvases/${encodeURIComponent(canvasId)}`
export const listProjects = (signal: AbortSignal) => requestV2<Project[]>(projectsPath, { signal })
export const readWorkspace = (id: string, signal: AbortSignal) => requestV2<Workspace>(`${projectPath(id)}/workspace`, { signal })
export const getPlacement = (id: string, signal: AbortSignal) => requestV2<Placement | null>(`${workItemPath(id)}/placement`, { signal })

function send<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', signal: AbortSignal, data?: unknown) {
  return requestV2<T>(path, { method, signal, body: JSON.stringify(data) })
}
export const createProject = (name: string, signal: AbortSignal) => send<Project>(projectsPath, 'POST', signal, { name })
export const renameProject = ({ id, revision }: Project, name: string, signal: AbortSignal) => send<Project>(projectPath(id), 'PUT', signal, { name, revision })
export const deleteProject = (id: string, signal: AbortSignal) => send<void>(projectPath(id), 'DELETE', signal)
export const command = ({ id, revision }: Project, action: Command, signal: AbortSignal) => send<{ id?: string }>(`${projectPath(id)}/commands`, 'POST', signal, { revision, ...action })
export const saveLayout = (id: string, canvasId: string | null, layout: Layout, signal: AbortSignal) => send<Layout>(`${projectPath(id)}/layout`, 'PUT', signal, { canvasId, ...layout })
