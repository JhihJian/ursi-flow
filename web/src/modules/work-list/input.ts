import type { InputDeclarations, InputType } from './model'

/** 表单草稿：布尔值保持布尔，其余声明都以文本编辑，提交时按声明解析。 */
export type Draft = Record<string, string | boolean>

export type Declarations = Array<[string, InputType]>

export function declarationsOf(inputs?: InputDeclarations): Declarations {
  return Object.entries(inputs ?? {})
}

/** 布尔项的初始值为 `false`，与其他保存字符串的项分开，避免把假值当缺失。 */
export function initialDraft(declarations: Declarations): Draft {
  return Object.fromEntries(declarations.map(([name, type]) => [name, type === 'boolean' ? false : '']))
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ParsedInput {
  input: Record<string, unknown>
  errors: Record<string, string>
  valid: boolean
}

/**
 * 按声明把草稿转成提交材料。空文本不是 `0` 也不是已填值，报错并保留原文本；
 * `false` 与 `0` 是有意义的值，照原样提交。
 */
export function parseDeclared(declarations: Declarations, draft: Draft): ParsedInput {
  const input: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const [name, type] of declarations) {
    const raw = draft[name]
    switch (type) {
      case 'boolean':
        input[name] = raw === true
        break
      case 'number':
      case 'integer': {
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (!text) { errors[name] = '请填写数字。'; break }
        const value = Number(text)
        if (!Number.isFinite(value)) { errors[name] = '请填写数字。'; break }
        if (type === 'integer' && !Number.isInteger(value)) { errors[name] = '请填写整数。'; break }
        input[name] = value
        break
      }
      case 'array':
      case 'object': {
        const text = typeof raw === 'string' ? raw.trim() : ''
        const wanted = type === 'array' ? 'JSON 数组' : 'JSON 对象'
        if (!text) { errors[name] = `请填写 ${wanted}。`; break }
        let value: unknown
        try { value = JSON.parse(text) } catch { errors[name] = `内容不是合法的 ${wanted}。`; break }
        if (type === 'array' ? !Array.isArray(value) : !isPlainObject(value)) {
          errors[name] = `需要一个 ${wanted}。`; break
        }
        input[name] = value
        break
      }
      default:
        input[name] = typeof raw === 'string' ? raw : ''
    }
  }
  return { input, errors, valid: Object.keys(errors).length === 0 }
}

/** 材料占位文案，帮助填表人区分六种声明。 */
export function placeholderOf(type: InputType): string {
  if (type === 'array') return '["第一项"]'
  if (type === 'object') return '{"字段":"值"}'
  if (type === 'integer') return '整数'
  if (type === 'number') return '数字'
  return ''
}
