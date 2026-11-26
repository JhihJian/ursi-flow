import { HomeError } from './pi-home.ts'

/**
 * settings.json 的 defaultTools 语义（对齐 pi 0.99 与 pi-web 的 powershell-settings）。
 *
 * defaultTools 是字符串数组：普通名字替换默认工具集，`+name` 添加、`-name` 移除，
 * 按列表顺序生效。设置页的「内置工具」是一组开关，开关状态要经过：
 *   已存 entries -> 解析出实际工具集 -> 取内置工具子集 -> 用户勾选 -> 写回最小 entries。
 * pi 的默认组合（read/bash/edit/write）写回时删除该 key，保持「跟随 pi 默认」。
 */

/** 设置页可开关的内置工具；`bash` 代表当前平台的 shell（Windows 上为 powershell）。 */
export const SETTINGS_BUILTIN_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'] as const

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write']
const SHELL_TOOLS = new Set(['bash', 'powershell'])

function isToolModifier(entry: string): boolean {
  return entry.startsWith('+') || entry.startsWith('-')
}

export function resolveDefaultToolEntries(entries: readonly string[]): string[] {
  const plain = entries.filter((entry) => !isToolModifier(entry))
  const tools = plain.length > 0 || entries.length === 0 ? plain : [...DEFAULT_TOOLS]
  for (const entry of entries) {
    if (!isToolModifier(entry)) continue
    const name = entry.slice(1)
    const index = tools.indexOf(name)
    if (entry.startsWith('+') && index === -1 && name) tools.push(name)
    else if (entry.startsWith('-') && index !== -1) tools.splice(index, 1)
  }
  return tools
}

export function readDefaultTools(settings: Record<string, unknown>): string[] | undefined {
  const raw = settings.defaultTools
  if (!Array.isArray(raw)) return undefined
  return raw.filter((entry): entry is string => typeof entry === 'string')
}

export function isPowerShellToolEnabled(
  defaultTools: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32'
    && defaultTools?.includes('powershell') === true
    && !defaultTools.includes('bash')
}

function replaceShellTool(toolNames: readonly string[], usePowerShell: boolean): string[] {
  const shell = usePowerShell ? 'powershell' : 'bash'
  const result: string[] = []
  for (const name of toolNames) {
    const next = SHELL_TOOLS.has(name) ? shell : name
    if (!result.includes(next)) result.push(next)
  }
  return result
}

/** 当前平台与 defaultTools 下的实际工具集（用于展示）。 */
export function resolvedToolsOf(
  entries: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const tools = entries === undefined ? DEFAULT_TOOLS : resolveDefaultToolEntries(entries)
  return replaceShellTool(tools, isPowerShellToolEnabled(entries, platform))
}

/** 当前 defaultTools 实际启用的内置工具（设置页开关的初始状态）。 */
export function builtinToolsOf(
  entries: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const tools = entries === undefined ? DEFAULT_TOOLS : resolveDefaultToolEntries(entries)
  const shells = platform === 'win32' ? [...SHELL_TOOLS] : ['bash']
  return SETTINGS_BUILTIN_TOOLS.filter((name) =>
    (name === 'bash' ? shells : [name]).some((tool) => tools.includes(tool)),
  )
}

/**
 * 写回最小 entries：其它条目（扩展工具、未知修饰）原样保留。
 * 返回 undefined 表示删除 defaultTools（等于 pi 默认，pi-web 的同一约定）。
 */
export function withBuiltinTools(
  entries: readonly string[] | undefined,
  selected: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  const shell = isPowerShellToolEnabled(entries && resolveDefaultToolEntries(entries), platform)
    ? 'powershell'
    : 'bash'
  const managed = platform === 'win32' ? [...SETTINGS_BUILTIN_TOOLS, 'powershell'] : [...SETTINGS_BUILTIN_TOOLS]
  const kept = (entries ?? []).filter((entry) =>
    !managed.includes(isToolModifier(entry) ? entry.slice(1) : entry),
  )
  const wanted: string[] = SETTINGS_BUILTIN_TOOLS
    .filter((name) => selected.includes(name))
    .map((name) => (name === 'bash' ? shell : name))
  // 已有普通名字（明确列举的工具集）时，内置工具也写成普通名字。
  if (kept.some((entry) => !isToolModifier(entry))) return [...new Set([...wanted, ...kept])]
  const next = [
    ...kept,
    ...DEFAULT_TOOLS.filter((name) => !wanted.includes(name)).map((name) => `-${name}`),
    ...wanted.filter((name) => !DEFAULT_TOOLS.includes(name)).map((name) => `+${name}`),
  ]
  return next.length > 0 ? next : undefined
}

/** 切换 PowerShell：替换 shell 工具并写成普通名字的工具集（pi-web 的同一行为）。 */
export function withPowerShell(
  entries: readonly string[] | undefined,
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const current = resolvedToolsOf(entries, platform)
  const next = replaceShellTool(current, enabled)
  if (!current.some((name) => SHELL_TOOLS.has(name))) next.push(enabled ? 'powershell' : 'bash')
  return next
}

export function assertBuiltinToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HomeError('builtinTools 必须是数组', 400, 'invalid_request')
  const names: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !(SETTINGS_BUILTIN_TOOLS as readonly string[]).includes(item)) {
      throw new HomeError(`未知的内置工具：${String(item)}`, 400, 'invalid_request')
    }
    if (!names.includes(item)) names.push(item)
  }
  return names
}
