import { ApiError, requestJson } from '@/shared/http/client'
import { useResource } from '@/shared/hooks/use-resource'
import { generationRunsPath, generatorsPath } from '@/shared/api/work-patch-generators'

export interface NavItem { path: string; title: string; icon: string; requiresFlow?: boolean }
export interface NavGroup { title: string; items: NavItem[] }

export const navigationGroups: NavGroup[] = [
  { title: '日常工作', items: [
    { path: '/work-items', title: '工作清单', icon: 'board' },
    { path: '/work-patches', title: '工作包', icon: 'folder' },
    { path: generationRunsPath, title: '生成记录', icon: 'runs' },
  ] },
  { title: '工作定义', items: [
    { path: generatorsPath, title: '工作包生成器', icon: 'workflow' },
    { path: '/config-patches', title: '配置包', icon: 'settings' },
    { path: '/resources', title: '资源库', icon: 'layers' },
    { path: '/executors', title: '执行器', icon: 'robot' },
  ] },
  { title: '平台设置', items: [
    { path: '/settings/agent-backends', title: 'Agent 后端', icon: 'robot' },
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
