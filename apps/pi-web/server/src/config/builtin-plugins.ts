import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HomeError } from '../shared/pi-home.ts'
import { detectPlugin } from '../chat/live-sessions.ts'

/**
 * 内置扩展的安装：把本仓自带的扩展文件复制进目标 home 的 extensions/ 目录。
 *
 * pi 加载扩展只认目录扫描，不认识 npm 包注册表，所以「安装」就是文件复制；
 * 不用软链：软链指回本仓源码，删仓库就断，且误写穿透源文件。已安装则整体替换
 * （先写临时文件再 rename），保证目标路径上永远是一个完整文件。
 */

/** 内置扩展清单：源文件相对仓库 apps/pi-web 的路径 + 一句话说明。 */
export interface BuiltinExtension {
  /** 安装后在 home 的 extensions/ 下的文件名。 */
  fileName: string
  /** 仓库内的源文件路径（相对 apps/pi-web）。 */
  sourceRelative: string
  description: string
}

const REPO_APP_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
  {
    fileName: 'pi-session-heartbeat.ts',
    sourceRelative: 'extension/pi-session-heartbeat.ts',
    description: '会话心跳：把运行中的会话写进 state/running-sessions，让 pi-web 会话视图看到绿点',
  },
]

/** 源文件一定随本服务一起部署：构建与 dev 都在 apps/pi-web 下运行。 */
function sourcePathOf(extension: BuiltinExtension): string {
  return join(REPO_APP_ROOT, extension.sourceRelative)
}

export interface BuiltinExtensionEntry {
  id: string
  fileName: string
  description: string
  /** 源文件是否存在：部署不完整时给安装入口一个明确解释。 */
  sourceAvailable: boolean
  installed: boolean
  /** 安装目标路径；未安装为 null。 */
  installedPath: string | null
}

export function listBuiltinExtensions(home: string): BuiltinExtensionEntry[] {
  return BUILTIN_EXTENSIONS.map((extension) => {
    const target = join(home, 'extensions', extension.fileName)
    const installed = isExtensionInstalled(home, extension.fileName)
    return {
      id: extension.fileName,
      fileName: extension.fileName,
      description: extension.description,
      sourceAvailable: existsSync(sourcePathOf(extension)),
      installed,
      installedPath: installed ? target : null,
    }
  })
}

/** 与心跳探测同一套识别规则：安装源文件（.ts）或编译副本（.js/index）任一存在即已安装。 */
export function isExtensionInstalled(home: string, _fileName: string): boolean {
  return detectPlugin(home)
}

export interface InstallResult {
  ok: true
  fileName: string
  /** 本次动作是全新安装还是替换旧文件。 */
  replaced: boolean
  installedPath: string
}

/** 安装（或重装）一个内置扩展；已安装时整体替换并如实回报。 */
export function installBuiltinExtension(home: string, id: string): InstallResult {
  const extension = BUILTIN_EXTENSIONS.find((item) => item.id === id)
  if (!extension) throw new HomeError(`没有这个内置扩展：${id}`, 404, 'builtin_not_found')
  const source = sourcePathOf(extension)
  if (!existsSync(source)) {
    throw new HomeError(`内置扩展源文件缺失：${extension.sourceRelative}`, 500, 'builtin_source_missing')
  }
  const extensionsDir = join(home, 'extensions')
  const target = join(extensionsDir, extension.fileName)
  mkdirSync(extensionsDir, { recursive: true })
  const replaced = existsSync(target)
  // 先写临时文件再 rename：目标路径上永远是一个完整文件，pi 不会读到半截。
  const temp = join(tmpdir(), `${basename(extension.fileName)}.${process.pid}.${Date.now()}.tmp`)
  try {
    copyFileSync(source, temp)
    renameSync(temp, target)
  } catch (cause) {
    rmSync(temp, { force: true })
    throw new HomeError(
      `安装失败：${cause instanceof Error ? cause.message : String(cause)}`,
      500,
      'builtin_install_failed',
    )
  }
  return { ok: true, fileName: extension.fileName, replaced, installedPath: target }
}

/** 卸载一个内置扩展：清掃四种安装形态，本来就没装时按成功返回（幂等）。 */
export function uninstallBuiltinExtension(home: string, id: string): { ok: true; fileName: string } {
  const extension = BUILTIN_EXTENSIONS.find((item) => item.id === id)
  if (!extension) throw new HomeError(`没有这个内置扩展：${id}`, 404, 'builtin_not_found')
  const stem = join(home, 'extensions', extension.fileName.replace(/\.ts$/, ''))
  rmSync(`${stem}.ts`, { force: true })
  rmSync(`${stem}.js`, { force: true })
  rmSync(join(stem, 'index.ts'), { force: true })
  rmSync(join(stem, 'index.js'), { force: true })
  return { ok: true, fileName: extension.fileName }
}
