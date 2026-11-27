import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LocationError, parse } from '@ursi/location'

/** flow home 不合法：用户输入问题，接口按 400 回，不算内部错误。 */
export class FlowHomeError extends Error {
  readonly status = 400
}

/**
 * Flow 包的默认根目录：每个子目录是一份以 FLOW.md 为入口的 Flow 包。
 * 存成位置 URI，与设置文件里的形态一致。
 */
export function defaultFlowHome(): string {
  return parse(process.env.FLOW_WEB_HOME ?? join(homedir(), '.ursi', 'flow')).uri
}

/**
 * 把用户给的 flow home 解析成规范位置 URI。
 *
 * 接受位置 URI `file:///abs`、裸绝对路径 `/abs`、本机简写 `~`、`~/x`。
 * 只认本机：Flow 引擎在 flow-web 服务端进程内执行，`Instruct.cwd` 没有设备维度，
 * 远程目录读回来也只会在本机 spawn，所以 `ssh://` 明确拒绝而不是悄悄退化。
 */
export function flowHomeOf(input: string): string {
  const raw = input.trim()
  let loc
  try {
    loc = parse(raw, { home: homedir() })
  } catch (error) {
    if (error instanceof LocationError && error.code === 'relative_path')
      throw new FlowHomeError(`flow home 必须是本机的绝对路径或 file:// URI：${raw}`)
    throw error
  }
  if (loc.scheme !== 'file')
    throw new FlowHomeError(
      'flow home 必须是本机目录：Flow 在工作台所在机器上执行，不支持 ssh://',
    )
  return loc.uri
}

/** 本服务自己的状态目录：设置文件与运行日志都放这里，不写进 flow home。 */
export function defaultStateDir(): string {
  return process.env.FLOW_WEB_STATE ?? join(homedir(), '.ursi', 'flow-web')
}

export interface Settings {
  /** Flow 包根目录，位置 URI（只可能是 `file://`）。 */
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
    if (typeof parsed.flowHome === 'string') return { flowHome: flowHomeOf(parsed.flowHome) }
  } catch {}
  return { flowHome: defaultFlowHome() }
}

/**
 * 保存 flow home。目录不存在时直接创建，避免用户先手动 mkdir 再回来配置。
 * 相对路径与 `ssh://` 被拒绝且原配置保留。
 */
export async function writeSettings(
  stateDir: string,
  patch: { flowHome: string },
): Promise<Settings> {
  const flowHome = flowHomeOf(patch.flowHome)
  await mkdir(parse(flowHome).path, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  const settings: Settings = { flowHome }
  await writeFile(
    pathsOf(stateDir).settingsFile,
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  )
  return settings
}
