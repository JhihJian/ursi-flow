import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pidsFile, runtimeFile } from './paths'

export interface Runtime {
  /** 本次运行生成的服务令牌。只写进 .run/runtime.json，不写进证据。 */
  token: string
  apiBase: string
  webBase: string
  apiPort: number
  webPort: number
  /** 真实 Server 二进制路径，支持环境变量覆盖。 */
  serverBin: string
  /** Server 启动环境，重启时原样复用。 */
  serverEnv: Record<string, string>
  /** Web 预览服务启动环境。 */
  webEnv: Record<string, string>
  dataDir: string
  workspaceDir: string
  homeDir: string
}

export function readRuntime(): Runtime {
  if (!existsSync(runtimeFile)) throw new Error(`缺少运行环境 ${runtimeFile}；先跑 global-setup`)
  return JSON.parse(readFileSync(runtimeFile, 'utf8')) as Runtime
}

export function writeRuntime(runtime: Runtime) {
  writeFileSync(runtimeFile, JSON.stringify(runtime, null, 2), { mode: 0o600 })
}

export interface Tracked {
  name: string
  pid: number
}

export function readPids(): Tracked[] {
  if (!existsSync(pidsFile)) return []
  try {
    return JSON.parse(readFileSync(pidsFile, 'utf8')) as Tracked[]
  } catch {
    return []
  }
}

export function writePids(entries: Tracked[]) {
  mkdirSync(path.dirname(pidsFile), { recursive: true })
  writeFileSync(pidsFile, JSON.stringify(entries, null, 2))
}
