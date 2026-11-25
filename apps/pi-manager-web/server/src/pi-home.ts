import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'

/**
 * pi home 的定位与校验。
 *
 * 一个 pi home 是 pi coding agent 的完整配置目录（默认 ~/.pi/agent），
 * 以 settings.json 的存在为判定标志。本服务不缓存"当前 home"：
 * 每个请求携带 ?home=，服务端逐次校验，无全局状态。
 */

export const DEFAULT_PI_HOME = join(homedir(), '.pi', 'agent')

export function defaultPiHome(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim()
  if (fromEnv) return resolve(fromEnv)
  return DEFAULT_PI_HOME
}

export class HomeError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** pi 是否认识一个目录：settings.json 存在（内容可以是任何合法 JSON）。 */
export function looksLikePiHome(dir: string): boolean {
  try {
    return statSync(join(dir, 'settings.json')).isFile()
  } catch {
    return false
  }
}

/**
 * 校验请求指定的 home：必须存在、是真实目录、realpath 后含 settings.json。
 * 返回 realpath 后的规范路径，后续所有文件操作都以它为根。
 */
export async function resolveRequestedHome(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HomeError('home 参数必须是目录绝对路径', 400, 'invalid_home')
  }
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/')) {
    throw new HomeError('home 必须是绝对路径', 400, 'invalid_home')
  }
  let real: string
  try {
    real = await realpath(trimmed)
  } catch {
    throw new HomeError(`目录不存在: ${trimmed}`, 404, 'home_not_found')
  }
  const info = await stat(real)
  if (!info.isDirectory()) {
    throw new HomeError(`不是目录: ${trimmed}`, 400, 'invalid_home')
  }
  if (!looksLikePiHome(real)) {
    throw new HomeError(
      `目录里没有 settings.json，不像是 pi home: ${real}`,
      400,
      'not_a_pi_home',
    )
  }
  return real
}

/** 供 /api/home/defaults 使用的默认 home（无参数校验宽松版）。 */
export function defaultHomeIfValid(): string | null {
  const dir = defaultPiHome()
  try {
    return looksLikePiHome(dir) ? dir : null
  } catch {
    return null
  }
}

export function homeExists(dir: string): boolean {
  return existsSync(dir)
}
