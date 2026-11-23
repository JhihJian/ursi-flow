import type { ReactNode } from 'react'

/**
 * 由 JSON Schema 动态生成调用表单。仅支持顶层 properties：
 * 字符串（含 enum 下拉）、数字、布尔开关、数组（每行一项）、对象（字段级 JSON）。
 * 结构不符合预期的属性自动退化为字段级 JSON 输入。
 */
export type SchemaProperty = {
  type?: string
  description?: string
  enum?: string[]
  items?: { type?: string; enum?: string[] }
}
export type Schema = { type?: string; properties?: Record<string, SchemaProperty>; required?: string[] }
export type FormValues = Record<string, string | boolean>

export function formable(schema: unknown): schema is Schema {
  return !!schema && typeof schema === 'object'
    && !!Object.keys(schema).includes('properties')
    && !!Object.entries(schema as Schema).find(([k]) => k === 'properties')?.[1]
    && Object.keys((schema as Schema).properties ?? {}).length > 0
}

function asText(value: unknown): string {
  return value === undefined || typeof value === 'boolean' ? '' : String(value)
}

/** 把已有的调用参数解析回表单值（模式切换时保留已填内容）。 */
export function hydrate(schema: Schema, parsed: Record<string, unknown>): FormValues {
  const values: FormValues = {}
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const raw = parsed[name]
    if (raw === undefined) continue
    if (prop.type === 'boolean') values[name] = raw === true
    else if (prop.type === 'array' && prop.items?.type === 'object')
      values[name] = Array.isArray(raw) ? JSON.stringify(raw) : ''
    else if (prop.type === 'array' && Array.isArray(raw)) values[name] = raw.map(asText).join('\n')
    else if (prop.type === 'object') values[name] = JSON.stringify(raw, null, 2)
    else values[name] = asText(raw)
  }
  return values
}

/** 组装调用参数；partial 只做序列化（模式切换用），完整提交时校验必填与格式。 */
export function buildArgs(schema: Schema, values: FormValues, partial = false): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const missing: string[] = []
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const required = schema.required?.includes(name) ?? false
    if (prop.type === 'boolean') {
      if (values[name] === true) args[name] = true
      else if (required && !partial) args[name] = false
      continue
    }
    const raw = asText(values[name])
    if (!raw.trim()) {
      if (required && !partial) missing.push(name)
      continue
    }
    if (prop.type === 'number' || prop.type === 'integer') {
      const num = Number(raw)
      if (Number.isNaN(num)) throw Error(`参数 ${name} 不是有效数字`)
      args[name] = num
    } else if (prop.type === 'array' && prop.items?.type === 'object') {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(raw)
      } catch {
        throw Error(`参数 ${name} 不是合法 JSON`)
      }
      if (!Array.isArray(parsedJson)) throw Error(`参数 ${name} 须为 JSON 数组`)
      args[name] = parsedJson
    } else if (prop.type === 'array')
      args[name] = raw.split('\n').map(line => line.trim()).filter(Boolean)
    else if (prop.type === 'object') {
      try {
        args[name] = JSON.parse(raw)
      } catch {
        throw Error(`参数 ${name} 不是合法 JSON`)
      }
    } else args[name] = raw
  }
  if (missing.length) throw Error(`缺少必填参数：${missing.join('、')}`)
  return args
}

type Props = { schema: Schema; values: FormValues; onChange: (values: FormValues) => void }

function fieldLabel(name: string, required: boolean): ReactNode {
  return <span className="font-medium">{name}{required && <span className="text-err" title="必填"> *</span>}</span>
}

export function SchemaForm({ schema, values, onChange }: Props) {
  const set = (name: string, value: string | boolean) => onChange({ ...values, [name]: value })
  const requiredCount = Object.keys(schema.properties ?? {}).filter(name => schema.required?.includes(name)).length
  return <div className="grid gap-3">
    {requiredCount > 0 && <p className="text-xs text-txt3">带 <span className="text-err">*</span> 为必填参数（{requiredCount} 个）</p>}
    {Object.entries(schema.properties ?? {}).map(([name, prop]) => {
      const required = schema.required?.includes(name) ?? false
      const hint = prop.description && <p className="text-xs text-txt3">{prop.description}</p>
      if (prop.type === 'boolean')
        return <div key={name}>
          <label className="flex items-center gap-2">{fieldLabel(name, required)}<input type="checkbox" className="switch" role="switch" aria-label={`参数 ${name}`} aria-required={required || undefined} checked={values[name] === true} onChange={e => set(name, e.target.checked)} /></label>
          {hint}
        </div>
      if (prop.enum?.length)
        return <label key={name} className="grid gap-1">{fieldLabel(name, required)}
          <select className="select" aria-label={`参数 ${name}`} aria-required={required || undefined} value={asText(values[name])} onChange={e => set(name, e.target.value)}>
            <option value="">未选择</option>
            {prop.enum.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
          {hint}
        </label>
      if (prop.type === 'number' || prop.type === 'integer')
        return <label key={name} className="grid gap-1">{fieldLabel(name, required)}
          <input className="input" type="number" step="any" aria-label={`参数 ${name}`} aria-required={required || undefined} value={asText(values[name])} onChange={e => set(name, e.target.value)} />
          {hint}
        </label>
      if (prop.type === 'array' || prop.type === 'object')
        return <label key={name} className="grid gap-1">{fieldLabel(name, required)}
          <textarea className="input block w-full font-mono" rows={prop.type === 'object' ? 4 : 3} aria-label={`参数 ${name}`} aria-required={required || undefined} placeholder={prop.type === 'array' ? '每行一项' : 'JSON'} value={asText(values[name])} onChange={e => set(name, e.target.value)} />
          {hint}
        </label>
      return <label key={name} className="grid gap-1">{fieldLabel(name, required)}
        <input className="input" aria-label={`参数 ${name}`} aria-required={required || undefined} value={asText(values[name])} onChange={e => set(name, e.target.value)} />
        {hint}
      </label>
    })}
  </div>
}
