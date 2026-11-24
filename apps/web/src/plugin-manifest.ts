import type { PluginDefinition } from './portal-contract'

export const pluginManifest: readonly PluginDefinition[] = [
  {
    id: 'workbench', name: 'Workbench', description: '工作项与工作包入口', enabledByDefault: true,
    placements: { 'left-top': true },
    load: () => import('./plugins/workbench'),
  },
  {
    id: 'project-links', name: '项目链接', description: '在首页显示项目仓库链接', enabledByDefault: true,
    placements: { right: true, 'left-bottom': false, center: false },
    load: () => import('./plugins/project-links'),
  },
  {
    id: 'portal-info', name: '门户信息', description: '显示项目标识和配置修订', enabledByDefault: true,
    placements: { title: true, status: true },
    load: () => import('./plugins/portal-info'),
  },
]
