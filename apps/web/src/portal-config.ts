import { webUrl } from './project.ts'
import type { ProjectInfo } from './project.ts'
import type { PluginDefinition, PortalContext } from './portal-contract.ts'

import { portalRegions, type PortalRegion } from './portal-regions.ts'

export type PluginSettings = { enabled: boolean; regions: Partial<Record<PortalRegion, boolean>> }
export type PortalConfig = {
  schemaVersion: 2
  revision: string
  page: Pick<ProjectInfo, 'brand' | 'name' | 'description'> & { repository: string }
  plugins: Record<string, PluginSettings>
  workbenchUrl: string
}

export type PublishedConfig = { config: PortalConfig; source: 'published' | 'development' | 'fallback'; problem?: string }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
export const limits = { brand: 64, name: 100, description: 1200, url: 2048 }

type PluginCatalog = readonly Pick<PluginDefinition, 'id' | 'placements'>[]

export function parsePortalConfig(input: unknown, catalog: PluginCatalog, origin: string): PortalConfig {
  if (!object(input) || !exactKeys(input, ['schemaVersion', 'revision', 'page', 'plugins', 'workbenchUrl']) || input.schemaVersion !== 2) {
    throw new Error('配置结构或配置版本无效')
  }
  if (typeof input.revision !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(input.revision)) throw new Error('配置修订号无效')
  const { page, plugins } = input
  if (!object(page) || !exactKeys(page, ['brand', 'name', 'description', 'repository'])) throw new Error('首页配置无效')
  function text(value: unknown, label: string, limit: number, required = true) {
    if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error(`${label}无效`)
    return value.trim()
  }
  function link(value: unknown, label: string) {
    const address = text(value, label, limits.url, false)
    if (address && !webUrl(address, origin)) throw new Error(`${label}须为 HTTP(S) 地址或以 / 开头的站内路径`)
    return address
  }
  if (!object(plugins) || !exactKeys(plugins, catalog.map(plugin => plugin.id))) throw new Error('包含未登记的插件')
  const settings = catalog.map(({ id, placements }) => {
    const allowed = portalRegions.filter(region => Object.hasOwn(placements, region))
    const entry = Object.hasOwn(plugins, id) ? plugins[id] : { enabled: false, regions: {} }
    if (!object(entry) || !exactKeys(entry, ['enabled', 'regions']) || typeof entry.enabled !== 'boolean') throw new Error(`插件 ${id} 的开关无效`)
    const { regions } = entry
    if (!object(regions) || !exactKeys(regions, allowed) || Object.values(regions).some(value => typeof value !== 'boolean')) throw new Error(`插件 ${id} 的区域配置无效`)
    return [id, { enabled: entry.enabled, regions: Object.fromEntries(allowed.map(region => [region, regions[region] === true])) }]
  })
  return {
    schemaVersion: 2,
    revision: input.revision,
    page: { brand: text(page.brand, '品牌', limits.brand), name: text(page.name, '项目名称', limits.name), description: text(page.description, '项目简介', limits.description, false), repository: link(page.repository, '仓库地址') },
    plugins: Object.fromEntries(settings),
    workbenchUrl: link(input.workbenchUrl, 'Workbench 地址'),
  }
}

export function defaultPortalConfig(context: PortalContext, manifest: readonly PluginDefinition[], development: boolean): PortalConfig {
  const { brand, name, description, repository } = context.project
  return {
    schemaVersion: 2, revision: development ? 'development' : 'fallback',
    page: { brand, name, description, repository: repository ?? '' },
    plugins: Object.fromEntries(manifest.map(plugin => [plugin.id, {
      enabled: development && plugin.enabledByDefault,
      regions: Object.fromEntries(portalRegions.filter(region => Object.hasOwn(plugin.placements, region)).map(region => [region, plugin.placements[region] === true])),
    }])),
    workbenchUrl: development ? (context.workbenchUrl ?? '') : '',
  }
}

export function applyPortalConfig(config: PortalConfig, context: PortalContext, origin: string): PortalContext {
  const { brand, name, description, repository } = config.page
  return { project: { id: context.project.id, brand, name, description, repository: webUrl(repository, origin) }, workbenchUrl: webUrl(config.workbenchUrl, origin), revision: config.revision }
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
    return { config: parsePortalConfig(input, manifest, window.location.origin), source: 'published' }
  } catch (error) {
    const problem = error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')
      ? '无法读取站点配置，插件未启动'
      : `${error instanceof Error ? error.message : '配置读取失败'}，插件未启动`
    return { config: fallback, source: 'fallback', problem }
  }
}
