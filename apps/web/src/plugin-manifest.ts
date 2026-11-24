import type { PluginDefinition } from './portal-contract'

export const pluginManifest: readonly PluginDefinition[] = [
  {
    id: 'workbench', name: 'Workbench', description: '工作项与工作包入口', enabledByDefault: true,
    placements: ['home.entries'],
    load: () => import('./plugins/workbench'),
  },
  {
    id: 'project-links', name: '项目链接', description: '在首页显示项目仓库链接', enabledByDefault: true,
    placements: ['home.aside'],
    load: () => import('./plugins/project-links'),
  },
]
