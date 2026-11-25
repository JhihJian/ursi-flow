/** 展示层格式化：字节、速率、时长、时间与端点拆分。 */

export function formatBytes(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-'
  const bytes = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(bytes)) return '-'
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let scaled = bytes / 1000
  let unit = 0
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000
    unit += 1
  }
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`
}

export function formatRate(value: string | number | null | undefined): string {
  const text = formatBytes(value)
  return text === '-' ? '-' : `${text}/s`
}

export function formatDuration(seconds: number | string | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds === '') return '-'
  const total = Math.max(0, Math.round(Number(seconds)))
  if (!Number.isFinite(total)) return '-'
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${rest}s`
  return `${rest}s`
}

/** ISO 时间转本地 `HH:MM:SS`，用于连接与日志这类密集时间列。 */
export function formatClock(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 与 now 的差值，向过去取整到分钟以内。 */
export function formatAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '-'
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return '-'
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return `${seconds}s 前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m 前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h 前`
  return `${Math.floor(seconds / 86400)}d 前`
}

export function formatElapsed(
  start: string | null | undefined,
  end: string | null | undefined,
  now = Date.now(),
): string {
  if (!start) return '-'
  const startTime = new Date(start).getTime()
  if (Number.isNaN(startTime)) return '-'
  const endTime = end ? new Date(end).getTime() : now
  if (Number.isNaN(endTime)) return '-'
  const seconds = (endTime - startTime) / 1000
  // 亚秒级会话在列表里显示 0s 会让人误以为时间缺失。
  if (seconds > 0 && seconds < 1) return '<1s'
  return formatDuration(seconds)
}

/** 缓存过期时间：未来给剩余时长，过去给“已过期”。 */
export function formatExpiry(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '-'
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return '-'
  const delta = Math.round((time - now) / 1000)
  if (delta <= 0) return '已过期'
  return `剩余 ${formatDuration(delta)}`
}

/** `1.2.3.4:443` 与 `[::1]:443` 都拆成 host + port。 */
export function splitEndpoint(endpoint: string | null | undefined): {
  host: string | null
  port: number | null
} {
  if (!endpoint) return { host: null, port: null }
  const trimmed = endpoint.trim()
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']')
    if (closing < 0) return { host: trimmed, port: null }
    const host = trimmed.slice(1, closing)
    const rest = trimmed.slice(closing + 1)
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : null
    return { host, port: Number.isFinite(port) ? port : null }
  }
  const separator = trimmed.lastIndexOf(':')
  if (separator < 0) return { host: trimmed, port: null }
  const port = Number(trimmed.slice(separator + 1))
  return { host: trimmed.slice(0, separator), port: Number.isFinite(port) ? port : null }
}

/** 出口链只保留可读的节点名，去掉 dae 的 `g_`/`n_` 前缀噪声。 */
export function chainLabel(chain: string[] | null | undefined): string {
  if (!chain || chain.length === 0) return '-'
  return chain.map((item) => item.replace(/^[gn]_/, '')).join(' → ')
}

export function percent(part: number, total: number): string {
  if (!total) return '0%'
  return `${Math.round((part / total) * 100)}%`
}
