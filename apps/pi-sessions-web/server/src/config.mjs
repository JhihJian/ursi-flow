import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const expandHome = (value) =>
  value === '~' || value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value

const positive = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * 只读环境配置。默认根只是初始值，浏览器里输入的任意绝对路径都能覆盖它。
 * 默认监听所有网卡，方便局域网里直接打开；服务只读且只认 `.jsonl`，
 * 需要收紧时把 `PI_SESSIONS_HOST` 设成 `127.0.0.1`。
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const defaultRoot = expandHome(env.PI_SESSIONS_ROOT?.trim() || '~/.pi/agent/sessions')
  const stateFile =
    env.PI_SESSIONS_STATE?.trim() ||
    join(homedir(), '.cache', 'pi-sessions-web', 'session-index.json')
  const staticDir = env.PI_SESSIONS_WEB_DIR?.trim() || resolve(import.meta.dirname, '../../web/dist')

  return {
    host: env.PI_SESSIONS_HOST ?? '0.0.0.0',
    port: positive(env.PI_SESSIONS_PORT, 30200),
    defaultRoot: isAbsolute(defaultRoot) ? defaultRoot : resolve(cwd, defaultRoot),
    /** 初始可选的根：默认根与它的上一级，方便从 `sessions/` 跳到 `agent/`。 */
    suggestedRoots: [...new Set([defaultRoot, resolve(defaultRoot, '..')])],
    stateFile: isAbsolute(stateFile) ? stateFile : resolve(cwd, stateFile),
    staticDir: isAbsolute(staticDir) ? staticDir : resolve(cwd, staticDir),
    maxTextBytes: positive(env.PI_SESSIONS_MAX_BYTES, 64 * 1024 * 1024),
  }
}
