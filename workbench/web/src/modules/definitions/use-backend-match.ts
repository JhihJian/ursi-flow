import { listPackageBackends, type PackageBackend } from '@/shared/api/agent-backends'
import { useResource } from '@/shared/hooks/use-resource'

export function unavailable(backend: PackageBackend) {
  if (!backend.configured) return '未配置'
  if (backend.status === 'failed') return '连通性检查失败'
  if (backend.status !== 'ready') return '尚未检查连通性'
  if (!backend.compatible) return '与此配置包不兼容'
  return ''
}

export function useBackendMatch(packageId: string) {
  const result = useResource(async signal => ({ packageId, items: packageId ? await listPackageBackends(packageId, signal) : [] }), null, packageId)
  // 换包时，不能在新请求发出前的那一帧沿用旧包的匹配结果。
  const current = !result.loading && !result.error && result.data?.packageId === packageId ? result.data : null
  const items = current?.items ?? []
  return { loading: result.loading || (!result.error && !current), error: result.error, reload: result.reload, items, choices: items.filter(b => !unavailable(b)) }
}
