import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const expandHome = (value) =>
  value === '~' || value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value

const positive = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * 环境配置。默认根只是初始值，浏览器里输入的任意绝对路径都能覆盖它。
 * 服务默认监听所有网卡，并假定运行在可信局域网里：删除会话与改偏好对任何
 * 能连上它的来源都放行，因此不要把它挂到不受信任的网络上。
 * 只想本机使用时把 `PI_SESSIONS_HOST` 设成 `127.0.0.1`。
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const defaultRoot = expandHome(env.PI_SESSIONS_ROOT?.trim() || '~/.pi/agent/sessions')
  const cacheDir = join(homedir(), '.cache', 'pi-sessions-web')
  const stateFile = env.PI_SESSIONS_STATE?.trim() || join(cacheDir, 'session-index.json')
  const prefsFile = env.PI_SESSIONS_PREFS?.trim() || join(cacheDir, 'prefs.json')
  const staticDir = env.PI_SESSIONS_WEB_DIR?.trim() || resolve(import.meta.dirname, '../../web/dist')

  return {
    host: env.PI_SESSIONS_HOST ?? '0.0.0.0',
    port: positive(env.PI_SESSIONS_PORT, 30200),
    defaultRoot: isAbsolute(defaultRoot) ? defaultRoot : resolve(cwd, defaultRoot),
    /** 初始可选的根：默认根与它的上一级，方便从 `sessions/` 跳到 `agent/`。 */
    suggestedRoots: [...new Set([defaultRoot, resolve(defaultRoot, '..')])],
    stateFile: isAbsolute(stateFile) ? stateFile : resolve(cwd, stateFile),
    /** 侧边栏偏好（特别关注的项目），与索引分开：索引丢了可以重建，偏好不行。 */
    prefsFile: isAbsolute(prefsFile) ? prefsFile : resolve(cwd, prefsFile),
    staticDir: isAbsolute(staticDir) ? staticDir : resolve(cwd, staticDir),
    maxTextBytes: positive(env.PI_SESSIONS_MAX_BYTES, 64 * 1024 * 1024),
  }
}
