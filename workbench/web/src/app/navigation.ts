import { ApiError, requestJson, requestV2 } from '@/shared/http/client'
import { useResource } from '@/shared/hooks/use-resource'

export type Capability = 'sources' | 'flow'
export interface NavItem { path: string; title: string; icon: string; capability?: Capability }
export interface NavGroup { title: string; items: NavItem[] }

export const navigationGroups: NavGroup[] = [
  { title: '日常工作', items: [
    { path: '/items', title: '工作清单', icon: 'board' },
    { path: '/sources', title: '外部来源', icon: 'connector', capability: 'sources' },
  ] },
  { title: '工作定义', items: [
    { path: '/packages', title: '工作包', icon: 'folder' },
    { path: '/resources', title: '资源库', icon: 'layers' },
    { path: '/executors', title: '执行器', icon: 'robot' },
  ] },
  { title: '运行工具', items: [
    { path: '/flows', title: 'Flow 包', icon: 'workflow', capability: 'flow' },
    { path: '/runs', title: '运行记录', icon: 'runs', capability: 'flow' },
    { path: '/flow-config', title: '运行配置', icon: 'settings', capability: 'flow' },
  ] },
  { title: '本地演示', items: [{ path: '/chat', title: '对话', icon: 'chat' }] },
]

// 只保存集合是否挂载，不缓存集合内容。详情页的 404 不影响导航。
export function useCapability(capability: Capability, signedIn: boolean) {
  return useResource(async signal => {
    if (!signedIn) return true
    try {
      if (capability === 'sources') await requestV2('/sources', { signal })
      else await requestJson('/flows', { signal })
      return true
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) return false
      throw cause
    }
  }, true)
}
