import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 状态根：每次按 env 现算，测试与迁移脚本改一个变量就能换目录。 */
function stateRoot(): string {
  const override = process.env.PI_WEB_STATE?.trim()
  if (override) return join(override)
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'pi-web')
}

/**
 * 状态目录布局。索引是缓存、偏好与 home 清单是用户数据，两者分文件存放：
 * 一个丢了能重扫，另一个丢了就是操作丢失。
 */
export interface StatePaths {
  root: string
  homes: string
  catalogDir: string
  index: string
  prefs: string
}

export function statePaths(): StatePaths {
  const root = stateRoot()
  return {
    root,
    homes: join(root, 'homes.json'),
    catalogDir: join(root, 'model-catalog'),
    index: join(root, 'sessions', 'index.json'),
    prefs: join(root, 'sessions', 'prefs.json'),
  }
}

/** 启动时建好目录：写文件前不必逐处判定父目录是否存在。 */
export function ensureStateDir(): void {
  const paths = statePaths()
  mkdirSync(paths.root, { recursive: true, mode: 0o700 })
  mkdirSync(paths.catalogDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(paths.root, 'sessions'), { recursive: true, mode: 0o700 })
}
