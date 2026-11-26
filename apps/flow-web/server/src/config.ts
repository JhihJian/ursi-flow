import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Flow 包的默认根目录：每个子目录是一份以 FLOW.md 为入口的 Flow 包。 */
export function defaultFlowHome(): string {
  return process.env.FLOW_WEB_HOME ?? join(homedir(), '.ursi', 'flow')
}

/** 本服务自己的状态目录：设置文件与运行日志都放这里，不写进 flow home。 */
export function defaultStateDir(): string {
  return process.env.FLOW_WEB_STATE ?? join(homedir(), '.ursi', 'flow-web')
}

export interface Settings {
  /** Flow 包根目录。 */
  flowHome: string
}

export interface Paths {
  stateDir: string
  settingsFile: string
  runsRoot: string
}

export function pathsOf(stateDir: string): Paths {
  return {
    stateDir,
    settingsFile: join(stateDir, 'settings.json'),
    runsRoot: process.env.FLOW_WEB_RUNS ?? join(stateDir, 'runs'),
  }
}

export async function readSettings(stateDir: string): Promise<Settings> {
  const file = pathsOf(stateDir).settingsFile
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { flowHome: defaultFlowHome() }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>
    if (typeof parsed.flowHome === 'string' && isAbsolute(parsed.flowHome))
      return { flowHome: parsed.flowHome }
  } catch {}
  return { flowHome: defaultFlowHome() }
}

/**
 * 保存 flow home。目录不存在时直接创建，避免用户先手动 mkdir 再回来配置。
 * 只接受绝对路径：相对路径会让服务的工作目录决定含义。
 */
export async function writeSettings(
  stateDir: string,
  patch: { flowHome: string },
): Promise<Settings> {
  const flowHome = resolve(patch.flowHome.trim())
  if (!isAbsolute(patch.flowHome.trim()))
    throw new Error('flow home 必须是绝对路径')
  await mkdir(flowHome, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  const settings: Settings = { flowHome }
  await writeFile(
    pathsOf(stateDir).settingsFile,
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  )
  return settings
}
