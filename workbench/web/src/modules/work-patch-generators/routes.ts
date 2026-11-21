import type { RouteObject } from 'react-router'
import { generationRunsPath, generatorsPath, newGeneratorPath } from '@/shared/api/work-patch-generators'

const generators = generatorsPath.slice(1)
const runs = generationRunsPath.slice(1)

export const workPatchGeneratorRoutes: RouteObject[] = [
  { path: generators, handle: { title: '工作包生成器' }, lazy: async () => ({ Component: (await import('./Generators')).Generators }) },
  { path: newGeneratorPath.slice(1), handle: { title: '新建工作包生成器' }, lazy: async () => ({ Component: (await import('./GeneratorEditor')).GeneratorEditor }) },
  { path: `${generators}/:id`, handle: { title: '生成器详情' }, lazy: async () => ({ Component: (await import('./Generators')).GeneratorDetail }) },
  { path: `${generators}/:id/edit`, handle: { title: '发布新版' }, lazy: async () => ({ Component: (await import('./GeneratorEditor')).GeneratorEditor }) },
  { path: `${generators}/:id/revisions`, handle: { title: '生成器历史版本' }, lazy: async () => ({ Component: (await import('./Generators')).GeneratorHistory }) },
  { path: `${generators}/:id/revisions/:revision`, handle: { title: '生成器版本' }, lazy: async () => ({ Component: (await import('./Generators')).GeneratorDetail }) },
  { path: runs, handle: { title: '生成记录' }, lazy: async () => ({ Component: (await import('./GenerationRuns')).GenerationRuns }) },
  { path: `${runs}/:id`, handle: { title: '生成详情' }, lazy: async () => ({ Component: (await import('./GenerationRuns')).GenerationRunDetail }) },
]
