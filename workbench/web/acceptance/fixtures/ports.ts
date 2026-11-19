/**
 * 联合验收使用的回环端口。默认值固定，便于报告复现；可用环境变量覆盖。
 * 端口被占用时 global-setup 直接失败并说明占用项，不复用别的实例。
 */
const read = (name: string, fallback: number) => {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} 必须是 1 到 65535 的整数`)
  return value
}

export const ports = {
  mainApi: read('URSI_ACCEPTANCE_MAIN_API_PORT', 18100),
  sourcesApi: read('URSI_ACCEPTANCE_SOURCES_API_PORT', 18101),
  model: read('URSI_ACCEPTANCE_MODEL_PORT', 18102),
  mainWeb: read('URSI_ACCEPTANCE_MAIN_WEB_PORT', 4180),
  sourcesWeb: read('URSI_ACCEPTANCE_SOURCES_WEB_PORT', 4181),
} as const

export const origin = (port: number) => `http://127.0.0.1:${port}`
