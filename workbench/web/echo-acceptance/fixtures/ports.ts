/**
 * 回执工作区联合验收使用的回环端口。默认值固定，便于复跑；
 * 可用环境变量覆盖，端口被占用时启动直接失败，不复用其他实例。
 */
const read = (name: string, fallback: number) => {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} 必须是 1 到 65535 的整数`)
  }
  return value
}

export const host = '127.0.0.1'
export const ports = {
  api: read('URSI_ECHO_ACCEPTANCE_API_PORT', 18200),
  web: read('URSI_ECHO_ACCEPTANCE_WEB_PORT', 4280),
} as const

export const origin = (port: number) => `http://${host}:${port}`
