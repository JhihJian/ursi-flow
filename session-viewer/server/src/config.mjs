import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

const expandHome = (value) =>
  value === '~' || value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value

const positive = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * 只读环境配置。路径一律来自环境变量，客户端传不进任何路径。
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const roots = (env.SESSION_VIEWER_ROOTS ?? '~/.pi/agent/sessions')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(expandHome)
    .map((value) => (isAbsolute(value) ? value : resolve(cwd, value)))

  const staticDir = env.SESSION_VIEWER_WEB_DIR ?? resolve(import.meta.dirname, '../../web/dist')

  return {
    roots,
    host: env.SESSION_VIEWER_HOST ?? '127.0.0.1',
    port: positive(env.SESSION_VIEWER_PORT, 30150),
    token: env.SESSION_VIEWER_TOKEN?.trim() || null,
    frameAncestors: env.SESSION_VIEWER_FRAME_ANCESTORS?.trim() || null,
    staticDir: isAbsolute(staticDir) ? staticDir : resolve(cwd, staticDir),
    maxBytes: positive(env.SESSION_VIEWER_MAX_BYTES, 64 * 1024 * 1024),
    indexTtlMs: positive(env.SESSION_VIEWER_INDEX_TTL_MS, 30_000),
  }
}
