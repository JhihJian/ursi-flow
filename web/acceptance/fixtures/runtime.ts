import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** web/acceptance/。测试、夹具和报告都在这个目录内。 */
export const acceptanceDir = fileURLToPath(new URL('..', import.meta.url))
/** 每次运行重建的临时运行目录，包含日志、临时数据目录与进程清单。 */
export const runDir = path.join(acceptanceDir, '.run')
export const evidenceDir = path.join(acceptanceDir, 'evidence')
export const runtimeFile = path.join(runDir, 'runtime.json')
export const pidsFile = path.join(runDir, 'pids.json')

export interface Runtime {
  /** 本次运行生成的服务令牌。只写进 .run/runtime.json，不写进证据目录。 */
  token: string
  mainApi: string
  sourcesApi: string
  mainWeb: string
  sourcesWeb: string
  modelUrl: string
  /** 模拟模型端点记录的请求，每行一个 JSON 对象。 */
  modelLog: string
  piBin: string
}

export function readRuntime(): Runtime {
  return JSON.parse(readFileSync(runtimeFile, 'utf8')) as Runtime
}
