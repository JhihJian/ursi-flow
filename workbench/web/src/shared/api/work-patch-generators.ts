import { requestV2 } from '@/shared/http/client'

export type ResourceRef = { alias: string; serverId: string; uri: string }

export type GeneratorRef = { id: string; revision: number }
export type GeneratorDraft = { id: string; name: string; aliases: string[]; script: string }
export type Generator = GeneratorDraft & { revision: number }
export type GeneratorBinding = GeneratorRef & { resources: ResourceRef[] }
export type ResourceEvidence = ResourceRef & { readAt: number; sha256: string }
export type StartGeneration = { generator: GeneratorRef; resources: ResourceRef[] } | { workItemId: string }
export type GenerationFilters = { generatorId?: string; workItemId?: string }
export type GeneratedFile = { path: string; bytes: number; sha256: string }
export type GenerationRun = {
  id: string
  generator: GeneratorRef
  workItemId?: string
  workItemTitle?: string
  initiator?: 'workbench-admin'
  resources: ResourceRef[]
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  startedAt: number
  finishedAt?: number
  evidence?: ResourceEvidence[]
  error?: { stage: string; message: string }
  result?: { name: string; directoryId: string; workPatchId?: string; files: GeneratedFile[] }
}

export const generatorsPath = '/work-patch-generators'
export const newGeneratorPath = `${generatorsPath}/new`
export const generationRunsPath = '/work-patch-generation-runs'
export const generatorPath = (id: string) => `${generatorsPath}/${encodeURIComponent(id)}`
export const generatorRevisionsPath = (id: string) => `${generatorPath(id)}/revisions`
export const generatorRevisionPath = ({ id, revision }: GeneratorRef) => `${generatorRevisionsPath(id)}/${revision}`
export const generationRunPath = (id: string) => `${generationRunsPath}/${encodeURIComponent(id)}`
export function generationHistoryPath({ generatorId, workItemId }: GenerationFilters = {}) {
  const query = new URLSearchParams()
  if (generatorId) query.set('generatorId', generatorId)
  if (workItemId) query.set('workItemId', workItemId)
  return query.size ? `${generationRunsPath}?${query}` : generationRunsPath
}

export const listGenerators = (signal: AbortSignal) => requestV2<Generator[]>(generatorsPath, { signal })
export const getGenerator = (id: string, signal: AbortSignal) => requestV2<Generator>(generatorPath(id), { signal })
export const listGeneratorRevisions = (id: string, signal: AbortSignal) => requestV2<Generator[]>(generatorRevisionsPath(id), { signal })
export const getGeneratorRevision = (ref: GeneratorRef, signal: AbortSignal) => requestV2<Generator>(generatorRevisionPath(ref), { signal })
export const publishGenerator = (body: GeneratorDraft, signal: AbortSignal) =>
  requestV2<Generator>(generatorsPath, { method: 'POST', body: JSON.stringify(body), signal })
export const startGeneration = (id: string, body: StartGeneration, signal: AbortSignal) =>
  requestV2<GenerationRun>(generationRunPath(id), { method: 'PUT', body: JSON.stringify(body), signal })
export const getGenerationRun = (id: string, signal: AbortSignal) => requestV2<GenerationRun>(generationRunPath(id), { signal })
export const listGenerationRuns = (filters: GenerationFilters, signal: AbortSignal) =>
  requestV2<GenerationRun[]>(generationHistoryPath(filters), { signal })
