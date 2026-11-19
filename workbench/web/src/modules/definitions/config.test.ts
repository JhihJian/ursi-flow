import { describe, expect, it } from 'vitest'
import { configStatus, configValuesForPublish, normalizeConfigSchema, sanitizeConfigValues, validateConfig } from './config'

const schema = normalizeConfigSchema({ fields: [
  { key: 'baseUrl', label: '服务地址', type: 'url', required: true },
  { key: 'token', label: '访问密钥', type: 'secret', required: true },
  { key: 'mode', label: '模式', type: 'enum', options: ['fast', 'safe'], required: true },
  { key: 'retries', label: '重试次数', type: 'integer', min: 0, max: 5 },
  { key: 'enabled', label: '启用', type: 'boolean' },
  { key: 'package', label: '配置包', type: 'configPackage', required: true },
] })

describe('执行器配置 schema', () => {
  it('只保留已知字段并支持服务端字段映射形状', () => {
    expect(normalizeConfigSchema({ baseUrl: { type: 'url' }, ignored: { type: 'path' } })).toEqual({ fields: [{ key: 'baseUrl', label: 'baseUrl', type: 'url' }] })
  })

  it('区分未配置、配置不完整和已配置，false 与 0 是有效值', () => {
    expect(configStatus(schema, {})).toBe('unconfigured')
    expect(configStatus(schema, { enabled: false, retries: 0 })).toBe('incomplete')
    expect(configStatus(schema, { baseUrl: 'https://example.test', mode: 'safe', enabled: false, retries: 0, package: 'cfg' }, {}, { token: true }, ['cfg'])).toBe('configured')
  })

  it('校验 URL、枚举、数值边界和配置包标识', () => {
    const errors = validateConfig(schema, { baseUrl: 'file:///private', mode: 'other', retries: 8, package: 'unknown' }, { token: 'secret' }, {}, ['cfg'])
    expect(errors).toEqual(['服务地址的值无效', '模式的值无效', '重试次数的值无效', '配置包的值无效'])
  })

  it('敏感值不进入普通草稿值或发布请求，已配置 secret 由状态表达', () => {
    const values = sanitizeConfigValues(schema, { baseUrl: 'https://example.test', token: 'plain-secret', enabled: false })
    expect(values).toEqual({ baseUrl: 'https://example.test', enabled: false })
    expect(configValuesForPublish(schema, values, {}, { token: true })).toEqual(values)
    expect(configValuesForPublish(schema, values, { token: 'new-secret' }, { token: true })).toEqual({ ...values, token: 'new-secret' })
  })
})
