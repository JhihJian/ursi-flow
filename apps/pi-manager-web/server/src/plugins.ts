import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSettings } from './settings-file.ts'

/**
 * 插件条目管理：只管 settings.json 的 packages 数组与 npm/ 安装目录的核对。
 *
 * pi 的 packages 条目是 string 或 object。object 的资源过滤列表
 * （extensions/skills/prompts/themes）全为空数组时是"禁用"编码；
 * 带非空过滤列表的条目禁用会丢过滤信息，管理台拒绝并提示。
 * 安装（npm 下载）不在本模块范围，UI 提示用 pi CLI 完成。
 */

export interface PackageEntryView {
  index: number
  /** string 条目是原始字符串；object 条目是 source 字段。 */
  source: string
  kind: 'plain' | 'object'
  disabled: boolean
  hasFilters: boolean
  autoload: boolean
  /** npm/ 下探测到的安装目录名（粗略核对）。 */
  installedDir: string | null
}

export interface PackagesMutation {
  /** 处理后的 packages 数组（写回 settings.json 的值）。 */
  packages: unknown[]
  /** 需要用户确认的风险提示；非空时写入被拒绝。 */
  refusals: string[]
}

export function listPackages(home: string): PackageEntryView[] {
  const settings = readSettings(home)
  const raw = settings.data.packages
  const npmDir = join(home, 'npm')
  const installed = new Set<string>()
  if (existsSync(npmDir)) {
    for (const entry of readdirSync(npmDir)) {
      installed.add(entry)
    }
  }
  const list = Array.isArray(raw) ? raw : []
  return list.map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        index,
        source: entry,
        kind: 'plain' as const,
        disabled: false,
        hasFilters: false,
        autoload: false,
        installedDir: findInstalledDir(installed, entry),
      }
    }
    const obj = (entry ?? {}) as Record<string, unknown>
    const source = typeof obj.source === 'string' ? obj.source : ''
    const lists = ['extensions', 'skills', 'prompts', 'themes'].map((k) => obj[k])
    const hasFilters = lists.some((v) => Array.isArray(v) && v.length > 0)
    const allEmpty = lists.every((v) => Array.isArray(v) && v.length === 0)
    return {
      index,
      source,
      kind: 'object' as const,
      disabled: allEmpty,
      hasFilters,
      autoload: obj.autoload === true,
      installedDir: findInstalledDir(installed, source),
    }
  })
}

function findInstalledDir(installed: Set<string>, source: string): string | null {
  // npm 包名（github:owner/repo#v1 等来源取 repo 名段）的目录名粗略匹配。
  const candidate = source.split('#')[0].split('/').pop() ?? ''
  if (!candidate) return null
  for (const dir of installed) {
    if (dir === candidate || dir.endsWith(candidate)) return dir
  }
  return null
}

/** 对 packages 数组应用一个操作，返回写回值；拒绝时给 refusals。 */
export function applyPackagesMutation(
  home: string,
  action: 'enable' | 'disable' | 'remove',
  targetIndex: number,
): PackagesMutation {
  const settings = readSettings(home)
  const list = Array.isArray(settings.data.packages) ? [...(settings.data.packages as unknown[])] : []
  if (targetIndex < 0 || targetIndex >= list.length) {
    return { packages: list, refusals: [`packages[${targetIndex}] 不存在`] }
  }
  const entry = list[targetIndex]
  const refusals: string[] = []
  if (typeof entry === 'string') {
    if (action === 'disable') {
      list[targetIndex] = {
        source: entry,
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      }
    } else if (action === 'enable') {
      // string 本来就是启用态。
    } else {
      list.splice(targetIndex, 1)
    }
    return { packages: list, refusals }
  }
  const obj = (entry ?? {}) as Record<string, unknown>
  const lists = ['extensions', 'skills', 'prompts', 'themes'].map((k) => obj[k])
  const hasFilters = lists.some((v) => Array.isArray(v) && v.length > 0)
  if (action === 'disable' && hasFilters) {
    refusals.push(
      '该条目带有资源过滤列表，禁用会永久丢失过滤信息。请直接编辑 settings.json 移除过滤字段后再禁用，或手动处理。',
    )
    return { packages: list, refusals }
  }
  if (action === 'disable') {
    list[targetIndex] = {
      source: typeof obj.source === 'string' ? obj.source : obj.source,
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    }
  } else if (action === 'enable') {
    const restored: Record<string, unknown> = { source: obj.source }
    if (obj.autoload !== undefined) restored.autoload = obj.autoload
    list[targetIndex] = restored
  } else {
    list.splice(targetIndex, 1)
  }
  return { packages: list, refusals }
}

export function hasPackageManagerState(home: string): boolean {
  const settingsPath = join(home, 'settings.json')
  if (!existsSync(settingsPath)) return false
  try {
    const text = readFileSync(settingsPath, 'utf8')
    return text.includes('"packages"')
  } catch {
    return false
  }
}

export function statFile(path: string): { size: number; mtime: number } | null {
  try {
    const info = statSync(path)
    return { size: info.size, mtime: Math.round(info.mtimeMs) }
  } catch {
    return null
  }
}
