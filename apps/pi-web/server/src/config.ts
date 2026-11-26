import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 进程级配置：唯一读 `process.env` 的地方（另一处是 state.ts 的目录布局）。
 *
 * 合并后的服务不再按域分端口与状态根：一个进程、一个状态目录、一套上限。
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** 进程实例 id：集合游标的 epoch，重启后客户端据此整份重取。 */
export const EPOCH = randomUUID()

export const HOST = process.env.PI_WEB_HOST ?? '0.0.0.0'
export const PORT = num(process.env.PI_WEB_PORT, 8093)

/** 独立页面产物；生产环境只有这个目录被托管。 */
export const STATIC_DIR = resolve(
  process.env.PI_WEB_STATIC_DIR ?? join(HERE, '..', '..', 'web', 'dist'),
)


/** 请求体上限：只有配置与对话提示走 POST，512KB 足够。 */
export const BODY_LIMIT = 512 * 1024

/** 对话运行时上限与空闲回收。 */
export const MAX_CHATS = num(process.env.PI_WEB_MAX_CHATS, 8)
export const CHAT_IDLE_MS = num(process.env.PI_WEB_CHAT_IDLE_MS, 30 * 60_000)
export const CHAT_UI_TIMEOUT_MS = num(process.env.PI_WEB_CHAT_UI_TIMEOUT_MS, 120_000)

/** 一次性任务上限、超时与并发。 */
export const MAX_TASKS = num(process.env.PI_WEB_MAX_TASKS, 4)
export const TASK_TIMEOUT_MS = num(process.env.PI_WEB_TASK_TIMEOUT_MS, 600_000)

/** 会话扫描：单次上限、正文上限、外部根数量与空闲 TTL。 */
export const SCAN_MAX_FILES = num(process.env.PI_WEB_MAX_FILES, 5000)
export const MAX_TEXT_BYTES = num(process.env.PI_WEB_MAX_TEXT_BYTES, 64 * 1024 * 1024)
export const EXTERNAL_ROOT_LIMIT = num(process.env.PI_WEB_EXTERNAL_ROOTS, 4)
export const EXTERNAL_ROOT_TTL_MS = num(process.env.PI_WEB_EXTERNAL_ROOT_TTL_MS, 30 * 60_000)

/** 会话列表初始根：独立入口没有 home 时用它。 */
export const SESSIONS_ROOT = process.env.PI_WEB_SESSIONS_ROOT?.trim() || ''
