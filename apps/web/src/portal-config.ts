import { webUrl } from './project.ts'
import type { ProjectInfo } from './project.ts'
import type { PluginDefinition, PortalContext } from './portal-contract.ts'

export type Placement = 'right' | 'below'
export type PortalConfig = {
  schemaVersion: 1
  revision: string
  page: Pick<ProjectInfo, 'brand' | 'name' | 'description'> & { repository: string; placement: Placement }
  plugins: Record<string, boolean>
  workbenchUrl: string
}

export type PublishedConfig = { config: PortalConfig; source: 'published' | 'development' | 'fallback'; problem?: string }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
export const limits = { brand: 64, name: 100, description: 1200, url: 2048 }

export function parsePortalConfig(input: unknown, pluginIds: readonly string[], origin: string): PortalConfig {
  if (!object(input) || !exactKeys(input, ['schemaVersion', 'revision', 'page', 'plugins', 'workbenchUrl']) || input.schemaVersion !== 1) {
    throw new Error('配置结构或配置版本无效')
  }
  if (typeof input.revision !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(input.revision)) throw new Error('配置修订号无效')
  const { page, plugins } = input
  if (!object(page) || !exactKeys(page, ['brand', 'name', 'description', 'repository', 'placement'])) throw new Error('首页配置无效')
  function text(value: unknown, label: string, limit: number, required = true) {
    if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error(`${label}无效`)
    return value.trim()
  }
  function link(value: unknown, label: string) {
    const address = text(value, label, limits.url, false)
    if (address && !webUrl(address, origin)) throw new Error(`${label}须为 HTTP(S) 地址或以 / 开头的站内路径`)
    return address
  }
  if (page.placement !== 'right' && page.placement !== 'below') throw new Error('扩展区位置无效')
  if (!object(plugins) || !exactKeys(plugins, [...pluginIds]) || Object.values(plugins).some(value => typeof value !== 'boolean')) throw new Error('插件开关包含未登记的插件或非布尔值')
  return {
    schemaVersion: 1,
    revision: input.revision,
    page: { brand: text(page.brand, '品牌', limits.brand), name: text(page.name, '项目名称', limits.name), description: text(page.description, '项目简介', limits.description, false), repository: link(page.repository, '仓库地址'), placement: page.placement },
    plugins: Object.fromEntries(pluginIds.map(id => [id, Object.hasOwn(plugins, id) && plugins[id] === true])),
    workbenchUrl: link(input.workbenchUrl, 'Workbench 地址'),
  }
}

export function defaultPortalConfig(context: PortalContext, manifest: readonly PluginDefinition[], development: boolean): PortalConfig {
  const { brand, name, description, repository } = context.project
  return {
    schemaVersion: 1, revision: development ? 'development' : 'fallback',
    page: { brand, name, description, repository: repository ?? '', placement: 'right' },
    plugins: Object.fromEntries(manifest.map(plugin => [plugin.id, development && plugin.enabledByDefault])),
    workbenchUrl: development ? (context.workbenchUrl ?? '') : '',
  }
}

export function applyPortalConfig(config: PortalConfig, context: PortalContext, origin: string): PortalContext {
  const { brand, name, description, repository } = config.page
  return { project: { id: context.project.id, brand, name, description, repository: webUrl(repository, origin) }, workbenchUrl: webUrl(config.workbenchUrl, origin) }
}

export async function loadPublishedConfig(context: PortalContext, manifest: readonly PluginDefinition[], development: boolean): Promise<PublishedConfig> {
  const fallback = defaultPortalConfig(context, manifest, false)
  try {
    const response = await fetch('/portal-config.json', { headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(4000) })
    if (response.status === 404 && development) return { config: defaultPortalConfig(context, manifest, true), source: 'development' }
    if (!response.ok) throw new Error(`配置请求返回 HTTP ${response.status}`)
    const type = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (type !== 'application/json') throw new Error('配置响应不是 JSON')
    let input: unknown
    try { input = await response.json() } catch { throw new Error('配置不是有效的 JSON') }
    return { config: parsePortalConfig(input, manifest.map(plugin => plugin.id), window.location.origin), source: 'published' }
  } catch (error) {
    const problem = error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')
      ? '无法读取站点配置，插件未启动'
      : `${error instanceof Error ? error.message : '配置读取失败'}，插件未启动`
    return { config: fallback, source: 'fallback', problem }
  }
}
