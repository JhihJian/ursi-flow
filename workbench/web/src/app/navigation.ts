import { ApiError, requestJson } from '@/shared/http/client'
import { useResource } from '@/shared/hooks/use-resource'
import { generationRunsPath, generatorsPath } from '@/shared/api/work-patch-generators'
import { selectProjectPath, type ProjectView } from '@/modules/work-items/projects/project-navigation'

export interface NavItem { path: string; title: string; icon: string; projectView?: ProjectView; requiresFlow?: boolean; management?: boolean; external?: boolean }
export interface NavGroup { title: string; items: NavItem[] }

export const navigationGroups: NavGroup[] = [
  { title: '日常工作', items: [
    { path: '/work-items', title: '工作清单', icon: 'board' },
    { path: selectProjectPath('map'), title: 'Canvas Map', icon: 'workflow', projectView: 'map' },
    { path: selectProjectPath('todo'), title: 'Todo', icon: 'board', projectView: 'todo' },
    { path: '/work-projects', title: '工作项目', icon: 'folder' },
    { path: '/work-patches', title: '工作包', icon: 'folder' },
    { path: generationRunsPath, title: '生成记录', icon: 'runs' },
  ] },
  { title: '工作定义', items: [
    { path: generatorsPath, title: '工作包生成器', icon: 'workflow' },
    { path: '/config-patches', title: '配置包', icon: 'settings', management: true },
    { path: '/resources', title: '资源库', icon: 'layers', management: true },
    { path: '/executors', title: '执行器', icon: 'robot', management: true },
  ] },
  { title: '平台设置', items: [
    { path: '/settings/agent-backends', title: 'Agent 后端', icon: 'robot', management: true },
    { path: '/mcp-servers', title: '平台 MCP 服务', icon: 'connector' },
    { path: '/platform-env', title: '环境变量', icon: 'settings' },
  ] },
  { title: '运行工具', items: [
    { path: '/flows', title: 'Flow 包', icon: 'workflow', requiresFlow: true },
    { path: '/runs', title: '运行记录', icon: 'runs', requiresFlow: true },
    { path: '/flow-config', title: '运行配置', icon: 'settings', requiresFlow: true },
  ] },
  { title: '本地演示', items: [{ path: '/chat', title: '对话', icon: 'chat' }] },
]

// 此地址只用于页面导航，不是 API base，也不携带当前令牌。
export function deployedNavigation(): NavGroup[] {
  const entry = document.querySelector<HTMLMetaElement>('meta[name="ursi-executor-management-url"]')?.content.trim()
  if (!entry) return navigationGroups
  let url: URL
  try { url = new URL(entry, window.location.origin) } catch { return navigationGroups }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return navigationGroups
  return navigationGroups.map(group => ({ ...group, items: [
    ...group.items.filter(item => !item.management),
    ...(group.title === '平台设置' ? [{ title: '执行器管理平台', icon: 'robot', path: url.href, external: true }] : []),
  ] }))
}

// 只保存集合是否挂载，不缓存集合内容。详情页的 404 不影响导航。
export function useFlowAvailability(signedIn: boolean) {
  return useResource(async signal => {
    if (!signedIn) return true
    try {
      await requestJson('/flows', { signal })
      return true
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) return false
      throw cause
    }
  }, true)
}
