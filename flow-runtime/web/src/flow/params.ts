// 启动参数分析：只从 FLOW.md 元信息里取全局变量声明，并把过程中由节点写入的变量排除掉。
// 结果变量表与 `variables.x` 提交指令代表「运行时产生」，不应当由操作者填写。
import { parse as parseYaml } from 'yaml'

export type ParamKind = 'text' | 'number' | 'boolean' | 'json'

export interface RunParam {
  name: string
  description: string
  /** 元信息里带 default，可以不填。 */
  hasDefault: boolean
  default?: unknown
  kind: ParamKind
  /** 提示词里用 `{var.x}` 读过；没读过也仍要提供，只是提醒操作者。 */
  referenced: boolean
}

export interface ParamAnalysis {
  /** 元信息里的展示名与用途说明。 */
  flowName?: string
  flowDescription?: string
  /** 需要操作者确认的启动参数。 */
  params: RunParam[]
  /** 过程中由节点写入、且有初始值的全局变量，不进入表单。 */
  internal: { name: string; description: string; initial?: unknown }[]
  /** 元信息读不出来时的原因，此时只能走高级 JSON 入口。 */
  error?: string
}

const VARIABLE_NAME = /^[\p{L}\p{N}_-]+$/u
const PLACEHOLDER_VAR = /\{var\.([\p{L}\p{N}_-]+)\}/gu
const SUBMIT_VARIABLE = /variables\.([\p{L}\p{N}_-]+)/gu
/** 提示词与结果说明里常见的写回说法：「更新全局变量 `记录`」。 */
const SUBMIT_GLOBAL = /全局变量[^`\n]{0,6}`([\p{L}\p{N}_-]+)`/gu

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 节点结果变量表的首列名字，按 `| 变量 | 含义 |` 表头识别。 */
function declaredResultVariables(body: string): Set<string> {
  const names = new Set<string>()
  const lines = body.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const header = cells(lines[index])
    if (header.length !== 2 || header[0] !== '变量' || header[1] !== '含义') continue
    for (let row = index + 2; row < lines.length && /^\s*\|/.test(lines[row]); row++) {
      const name = cells(lines[row])[0]
      if (VARIABLE_NAME.test(name)) names.add(name)
    }
  }
  return names
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'))
}

/** 运行时写入的变量：节点自己提交，或提示词里要求写回 `variables.x`。 */
function writtenVariables(body: string): Set<string> {
  const names = declaredResultVariables(body)
  for (const match of body.matchAll(SUBMIT_VARIABLE)) names.add(match[1])
  for (const match of body.matchAll(SUBMIT_GLOBAL)) names.add(match[1])
  return names
}

function readVariables(body: string): Set<string> {
  const names = new Set<string>()
  for (const match of body.matchAll(PLACEHOLDER_VAR)) names.add(match[1])
  return names
}

export function paramKind(value: unknown): ParamKind {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object' && value !== null) return 'json'
  return 'text'
}

export function analyzeParams(markdown: string): ParamAnalysis {
  const head = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown)
  if (!head) return { params: [], internal: [], error: 'FLOW.md 缺少元信息，读不到启动参数' }
  let meta: unknown
  try {
    meta = parseYaml(head[1])
  } catch (error) {
    return {
      params: [],
      internal: [],
      error: `元信息不是有效 YAML：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const flowName = isRecord(meta) && typeof meta.name === 'string' ? meta.name : undefined
  const flowDescription =
    isRecord(meta) && typeof meta.description === 'string' ? meta.description : undefined
  const declarations = isRecord(meta) && isRecord(meta.variables) ? meta.variables : {}
  const body = markdown.slice(head[0].length)
  const written = writtenVariables(body)
  const read = readVariables(body)
  const params: RunParam[] = []
  const internal: ParamAnalysis['internal'] = []
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!isRecord(declaration)) continue
    const description = typeof declaration.description === 'string' ? declaration.description : ''
    const hasDefault = Object.hasOwn(declaration, 'default')
    // 节点自己写入且带初始值的变量是运行状态，不需要操作者提供。
    if (hasDefault && written.has(name)) {
      internal.push({ name, description, initial: declaration.default })
      continue
    }
    const param: RunParam = {
      name,
      description,
      hasDefault,
      kind: paramKind(declaration.default),
      referenced: read.has(name),
    }
    if (hasDefault) param.default = declaration.default
    params.push(param)
  }
  return { flowName, flowDescription, params, internal }
}

/** 表单里的文本转回 JSON 值；text 保留原文，其余按类型解析。 */
export function toValue(param: RunParam, text: string): { value?: unknown; error?: string } {
  if (param.kind === 'number') {
    const value = Number(text)
    return text.trim() && Number.isFinite(value) ? { value } : { error: '必须是数字' }
  }
  if (param.kind === 'boolean') return { value: text === 'true' }
  if (param.kind === 'json') {
    try {
      return { value: JSON.parse(text) }
    } catch {
      return { error: '必须是有效 JSON' }
    }
  }
  return { value: text }
}

/** JSON 值转成表单文本；空值给空串，让必填项保持可见的空状态。 */
export function toText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}
