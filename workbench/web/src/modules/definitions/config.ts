export const configFieldTypes = ['string', 'url', 'secret', 'enum', 'integer', 'number', 'boolean', 'configPackage'] as const
export type ConfigFieldType = typeof configFieldTypes[number]

export type ConfigOption = { value: string; label: string }
export type ConfigField = {
  key: string
  label: string
  type: ConfigFieldType
  description?: string
  required?: boolean
  options?: ConfigOption[]
  min?: number
  max?: number
}
export type ConfigSchema = { fields: ConfigField[] }
export type ConfigValue = string | number | boolean
export type ConfigValues = Record<string, ConfigValue>
export type SecretValues = Record<string, string>
export type SecretConfigured = Record<string, boolean>
export type ConfigStatus = 'unconfigured' | 'incomplete' | 'configured'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function option(value: unknown): ConfigOption | null {
  if (typeof value === 'string') return { value, label: value }
  const obj = record(value)
  if (!obj || typeof obj.value !== 'string') return null
  return { value: obj.value, label: typeof obj.label === 'string' ? obj.label : obj.value }
}

function field(key: string, value: unknown): ConfigField | null {
  const obj = record(value)
  if (!obj) return null
  const type = obj.type ?? obj.kind
  if (typeof type !== 'string' || !(configFieldTypes as readonly string[]).includes(type)) return null
  const options = Array.isArray(obj.options) ? obj.options.map(option).filter((v): v is ConfigOption => v !== null) : undefined
  return {
    key,
    label: typeof obj.label === 'string' && obj.label ? obj.label : key,
    type: type as ConfigFieldType,
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    ...(obj.required === true ? { required: true } : {}),
    ...(options?.length ? { options } : {}),
    ...(typeof obj.min === 'number' ? { min: obj.min } : {}),
    ...(typeof obj.max === 'number' ? { max: obj.max } : {}),
  }
}

/**
 * 服务端合并期间允许 schema 使用 fields 数组或字段名映射，但组件内部只消费一种形状。
 * 未知字段类型被丢弃，避免把任意服务端对象当成可编辑配置。
 */
export function normalizeConfigSchema(value: unknown): ConfigSchema {
  const obj = record(value)
  const sourceFields = Array.isArray(value) ? value : obj?.fields
  if (!obj && !Array.isArray(value)) return { fields: [] }
  const rawFields = Array.isArray(sourceFields)
    ? sourceFields.flatMap((item) => {
      const itemObj = record(item)
      const key = typeof itemObj?.key === 'string' ? itemObj.key : typeof itemObj?.name === 'string' ? itemObj.name : ''
      const normalized = key ? field(key, item) : null
      return normalized ? [normalized] : []
    })
    : Object.entries(obj ?? {}).flatMap(([key, item]) => {
      const normalized = field(key, item)
      return normalized ? [normalized] : []
    })
  const seen = new Set<string>()
  return { fields: rawFields.filter((item) => !seen.has(item.key) && seen.add(item.key)) }
}

export function nonSecretFields(schema: ConfigSchema) {
  return schema.fields.filter((item) => item.type !== 'secret')
}

export function sanitizeConfigValues(schema: ConfigSchema, values: unknown): ConfigValues {
  const source = record(values)
  if (!source) return {}
  const result: ConfigValues = {}
  for (const item of nonSecretFields(schema)) {
    const value = source[item.key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[item.key] = value
  }
  return result
}

function validValue(item: ConfigField, value: unknown, packages: readonly string[] = []): boolean {
  if (item.type === 'secret') return false
  if (item.type === 'boolean') return typeof value === 'boolean'
  if (item.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) && (item.min === undefined || value >= item.min) && (item.max === undefined || value <= item.max)
  if (item.type === 'number') return typeof value === 'number' && Number.isFinite(value) && (item.min === undefined || value >= item.min) && (item.max === undefined || value <= item.max)
  if (typeof value !== 'string' || !value.trim()) return false
  if (item.type === 'url') {
    try {
      const parsed = new URL(value)
      if (!['http:', 'https:'].includes(parsed.protocol)) return false
    } catch { return false }
  }
  if (item.type === 'enum' && !item.options?.some((option) => option.value === value)) return false
  if (item.type === 'configPackage' && !packages.includes(value)) return false
  return true
}

function effectiveValue(item: ConfigField, values: ConfigValues, secrets: SecretValues, configured: SecretConfigured) {
  return item.type === 'secret' ? (secrets[item.key]?.trim() || configured[item.key] ? true : undefined) : values[item.key]
}

export function configStatus(schema: ConfigSchema, values: ConfigValues, secrets: SecretValues = {}, configured: SecretConfigured = {}, packageIds: readonly string[] = []): ConfigStatus {
  if (!schema.fields.length) return 'unconfigured'
  const anyValue = schema.fields.some((item) => {
    const value = effectiveValue(item, values, secrets, configured)
    return value !== undefined && value !== ''
  })
  const incomplete = schema.fields.some((item) => {
    const value = effectiveValue(item, values, secrets, configured)
    if (value === undefined || value === '') return item.required === true
    return item.type !== 'secret' && !validValue(item, value, packageIds)
  })
  if (incomplete) return anyValue ? 'incomplete' : 'unconfigured'
  return anyValue ? 'configured' : 'unconfigured'
}

export function validateConfig(schema: ConfigSchema, values: ConfigValues, secrets: SecretValues = {}, configured: SecretConfigured = {}, packageIds: readonly string[] = []) {
  return schema.fields.flatMap((item) => {
    const value = effectiveValue(item, values, secrets, configured)
    if (value === undefined || value === '') return item.required ? [`${item.label}为必填项`] : []
    if (item.type === 'secret' || validValue(item, value, packageIds)) return []
    return [`${item.label}的值无效`]
  })
}

export function configValuesForPublish(schema: ConfigSchema, values: ConfigValues, secrets: SecretValues = {}, configured: SecretConfigured = {}) {
  const result: Record<string, ConfigValue | string> = { ...sanitizeConfigValues(schema, values) }
  for (const item of schema.fields) {
    if (item.type === 'secret' && secrets[item.key]?.trim()) result[item.key] = secrets[item.key].trim()
    else if (item.type === 'secret' && configured[item.key]) delete result[item.key]
  }
  return result
}

export const configStatusLabels: Record<ConfigStatus, string> = {
  unconfigured: '未配置',
  incomplete: '配置不完整',
  configured: '已配置',
}
