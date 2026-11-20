import type { PatchKind } from './api'

export interface PatchKindMeta {
  title: string
  description: string
  icon: string
}

/** 两类包共用一套页面框架，只在这里区分标题、入口和图标。 */
export const patchKindMeta: Record<PatchKind, PatchKindMeta> = {
  work: {
    title: '工作包',
    description: '把一次任务需要的文件整理成一个可编辑目录。',
    icon: 'folder',
  },
  config: {
    title: '配置包',
    description: '维护系统提示词、Skills 与 MCP 配置。',
    icon: 'settings',
  },
}

export const patchListPath = (kind: PatchKind) => kind === 'work' ? '/work-patches' : '/config-patches'

export const patchPath = (kind: PatchKind, id: string) => `${patchListPath(kind)}/${encodeURIComponent(id)}`
export const workPatchExecutePath = (id: string) => `${patchPath('work', id)}/execute`
