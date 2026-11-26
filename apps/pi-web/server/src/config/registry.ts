import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { HomeRegistry, type HomeEntry, type HomeSummary } from './homes.ts'
import { HomeError, resolveRequestedHome } from '../shared/pi-home.ts'

/**
 * home 注册表：进程内唯一实例。
 *
 * 配置域写它，对话与会话域只读；`profileRevision` 也在这里维护，因为它是
 * 「同一份 home 的配置版本」，属于聚合根的派生字段。
 */

export const homes = new HomeRegistry()

/** 参与 profile 版本的配置文件：任一变化即视为配置变更。 */
const PROFILE_FILES = [
  'settings.json',
  'models.json',
  'auth.json',
  'mcp.json',
  'agents/settings.json',
]

const profileState = new Map<string, { hash: string; revision: number }>()

function hashProfile(homePath: string): string {
  const hash = createHash('sha256')
  for (const relative of PROFILE_FILES) {
    const info = statSync(join(homePath, relative), { throwIfNoEntry: false })
    hash.update(`${relative}:${info ? `${Math.round(info.mtimeMs)}.${info.size}` : 'absent'}\n`)
  }
  return hash.digest('hex')
}

/** 单调递增的配置版本：内容摘要变化时 +1，进程重启后从 1 重新计。 */
export function profileRevisionOf(homePath: string): number {
  const hash = hashProfile(homePath)
  const current = profileState.get(homePath)
  if (!current) {
    profileState.set(homePath, { hash, revision: 1 })
    return 1
  }
  if (current.hash !== hash) {
    current.hash = hash
    current.revision += 1
  }
  return current.revision
}

export interface HomeView extends HomeSummary {
  sessionsRoot: string
  profileRevision: number
  capabilities: {
    skills: number
    agents: number
    mcpServers: number
    packages: number
    hasModels: boolean
    hasAuth: boolean
  }
}

export function homeViewOf(summary: HomeSummary): HomeView {
  const sessionsRoot = join(summary.path, 'sessions')
  return {
    ...summary,
    sessionsRoot,
    profileRevision: summary.valid ? profileRevisionOf(summary.path) : 0,
    capabilities: {
      skills: summary.skills,
      agents: summary.agents,
      mcpServers: summary.mcpServers,
      packages: summary.packages,
      hasModels: summary.hasModels,
      hasAuth: summary.hasAuth,
    },
  }
}

/** 按 id 或 realpath 找一份 home；找不到时给出可读错误。 */
export function requireHome(idOrPath: string): HomeSummary {
  const summary = homes.list().find((item) => item.id === idOrPath || item.path === idOrPath)
  if (summary) return summary
  throw new HomeError(`没有这个 pi home：${idOrPath}`, 404, 'home_not_found')
}

/** 把 agent 参数解析成清单条目：name 优先，也接受 id 与绝对路径便于脚本使用。 */
export function resolveAgent(raw: unknown): HomeEntry {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HomeError('agent 必填（pi home 的名称）', 400, 'invalid_request')
  }
  const key = raw.trim()
  const byName = homes.findByName(key)
  if (byName) return byName
  const byId = homes.get(key)
  if (byId) return byId
  if (key.startsWith('/')) {
    for (const entry of homes.list()) {
      if (entry.path === key && entry.listed) {
        return { id: entry.id, name: entry.name, path: entry.path, description: entry.description }
      }
    }
  }
  const known = homes.list().filter((h) => h.listed).map((h) => h.name)
  throw new HomeError(
    `没有这个 agent：${key}${known.length ? `（可用：${known.join('、')}）` : '（清单为空，先在侧边栏新增 pi home）'}`,
    404,
    'agent_not_found',
  )
}

export async function resolveHomeById(id: string): Promise<string> {
  return resolveRequestedHome(requireHome(id).path)
}
