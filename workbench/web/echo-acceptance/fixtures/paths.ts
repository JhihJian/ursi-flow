import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** web/echo-acceptance/，夹具、临时运行目录和证据都在这里。 */
export const acceptanceDir = fileURLToPath(new URL('..', import.meta.url))
/** web/，构建与依赖所在目录。 */
export const webRoot = path.resolve(acceptanceDir, '..')
/** workbench/，Cargo 工作区所在目录。 */
export const workbenchRoot = path.resolve(webRoot, '..')

export const runDir = path.join(acceptanceDir, '.run')
export const evidenceDir = path.join(acceptanceDir, 'evidence')
export const logDir = path.join(runDir, 'logs')
export const runtimeFile = path.join(runDir, 'runtime.json')
export const pidsFile = path.join(runDir, 'pids.json')

/** 临时业务数据、工作区与 HOME 目录，都在 .run 内，收尾时删除。 */
export const dataDir = path.join(runDir, 'data')
export const workspaceDir = path.join(runDir, 'workspace')
export const homeDir = path.join(runDir, 'home')

export const viteBin = path.join(webRoot, 'node_modules/.bin/vite')
export const defaultServerBin = path.join(workbenchRoot, 'target/debug/ursi-server')
