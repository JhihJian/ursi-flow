// FLOW.md 文档模型：开头元信息、Mermaid 图与各节点的动作/结果小节。
// 图形编辑只改图语句和小节骨架，节点提示词与脚本正文保持原文。
import { parseGraph, serializeGraph, type ActionKind, type FlowGraph } from './graph'

export interface FlowSection {
  name: string
  body: string
}
export interface ParsedFlow {
  /** 开头元信息，包含两侧的 `---`；没有元信息时为空串。 */
  frontmatter: string
  /** 元信息与图之间的原文。 */
  pre: string
  graph: FlowGraph
  /** 图之后的原文，节点小节都在这里。 */
  post: string
}

const fence = '```'
const mermaidFence = /```mermaid[^\n]*\n([\s\S]*?)```/
export const ACTION_FENCE = /```(新建Agent|复用Agent|执行自定义命令|执行Flow)[ \t]*\n([\s\S]*?)```/

export function parseFlow(text: string): ParsedFlow {
  let frontmatter = ''
  let rest = text
  const head = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  if (head) {
    frontmatter = head[0].replace(/\r\n/g, '\n').replace(/\n*$/, '\n')
    rest = text.slice(head[0].length)
  }
  const match = rest.match(mermaidFence)
  if (!match) throw new Error('FLOW.md 缺少 mermaid 图')
  const start = match.index ?? 0
  return {
    frontmatter,
    pre: rest.slice(0, start),
    graph: parseGraph(match[1]),
    post: rest.slice(start + match[0].length),
  }
}

export function serializeFlow(doc: ParsedFlow): string {
  const pre = doc.pre && !doc.pre.endsWith('\n\n') ? doc.pre.trimEnd() + '\n\n' : doc.pre
  const post = doc.post.replace(/^\n+/, '')
  const graph = serializeGraph(doc.graph).replace(/\n*$/, '\n')
  return `${doc.frontmatter}${pre}${fence}mermaid\n${graph}${fence}\n\n${post}`.replace(
    /\s+$/,
    '\n',
  )
}

/** 按行遍历，跳过代码块内容，避免把提示词里的标题当成小节。 */
function walk(lines: string[], visit: (line: string, index: number, inFence: boolean) => void) {
  let inFence = false
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      visit(line, index, inFence)
      inFence = !inFence
      return
    }
    visit(line, index, inFence)
  })
}

export function splitSections(post: string): { prologue: string; sections: FlowSection[] } {
  const lines = post.split('\n')
  const heads: { name: string; line: number }[] = []
  walk(lines, (line, index, inFence) => {
    if (inFence) return
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading && !line.startsWith('###')) heads.push({ name: heading[1], line: index })
  })
  const sections = heads.map((head, index) => {
    const from = head.line + 1
    const to = heads[index + 1]?.line ?? lines.length
    return { name: head.name, body: lines.slice(from, to).join('\n').trim() }
  })
  const prologue = lines
    .slice(0, heads[0]?.line ?? lines.length)
    .join('\n')
    .trim()
  return { prologue, sections }
}

export function joinSections(prologue: string, sections: FlowSection[]): string {
  const blocks = sections.map((section) => `## ${section.name}\n\n${section.body}`.trimEnd())
  return ['', prologue.trim(), ...blocks, ''].filter((part) => part !== '').join('\n\n') + '\n'
}

export function actionOf(section: FlowSection): { kind: ActionKind; body: string } | null {
  const match = section.body.match(ACTION_FENCE)
  if (!match) return null
  return { kind: match[1] as ActionKind, body: match[2].replace(/\s+$/, '') }
}

/** 把小节正文拆成「动作块之前 / 结果块」。 */
function partition(body: string) {
  const action = body.match(ACTION_FENCE)
  if (!action) return { prefix: body.trimEnd(), blocks: new Map<string, string[]>(), order: [] as string[] }
  const prefix = body.slice(0, (action.index ?? 0) + action[0].length).trimEnd()
  const tail = body.slice((action.index ?? 0) + action[0].length)
  const lines = tail.split('\n')
  const blocks = new Map<string, string[]>()
  const order: string[] = []
  let current: string | null = null
  walk(lines, (line, _index, inFence) => {
    const heading = inFence ? null : line.match(/^###\s+(.+?)\s*$/)
    if (heading) {
      current = heading[1]
      order.push(current)
      blocks.set(current, [])
      return
    }
    if (current) blocks.get(current)?.push(line)
  })
  for (const [name, body] of blocks) blocks.set(name, [body.join('\n').trim()])
  return { prefix, blocks, order }
}

export function resultsOf(section: FlowSection): string[] {
  return partition(section.body).order
}

const defaultBody: Record<ActionKind, string> = {
  新建Agent: '在这里写节点提示词，使用 {var.任务} 引用全局变量。',
  复用Agent: '继续使用本次运行已绑定的 Agent，使用 {input.变量} 引用上一节点结果。',
  执行自定义命令: `{
  "command": "node",
  "args": ["-e", "console.log('hello')"]
}`,
  执行Flow: `{
  "flow": "另一个兄弟 Flow 的标识"
}`,
}

/** 动作类型分三族，族内切换可以沿用正文，跨族切换要换成对应的默认内容。 */
const family = (kind: ActionKind) => (kind === '执行自定义命令' ? 'command' : kind === '执行Flow' ? 'flow' : 'agent')

export function setAction(section: FlowSection, kind: ActionKind): FlowSection {
  const action = section.body.match(ACTION_FENCE)
  // 动作类型未变时保留原文，避免无意义的空白规范化进入 diff。
  if (action && action[1] === kind) return section
  if (action && family(action[1] as ActionKind) !== family(kind)) {
    // Agent 提示词换成命令 JSON（或反过来）只会得到非法内容，直接换成默认骨架。
    const before = section.body.slice(0, action.index)
    const after = section.body.slice((action.index ?? 0) + action[0].length)
    return {
      ...section,
      body: `${before}${fence}${kind}\n${defaultBody[kind]}\n${fence}${after}`.trimEnd(),
    }
  }
  if (action) {
    const before = section.body.slice(0, action.index)
    const after = section.body.slice((action.index ?? 0) + action[0].length)
    return {
      ...section,
      body: `${before}${fence}${kind}\n${action[2].replace(/\s+$/, '')}\n${fence}${after}`.trimEnd(),
    }
  }
  const block = `${fence}${kind}\n${defaultBody[kind]}\n${fence}`
  return { ...section, body: (block + (section.body.trim() ? `\n\n${section.body.trim()}` : '')).trimEnd() }
}

/** 新增结果小节的占位说明。规范要求每条结果边都有非空说明。 */
const resultPlaceholder = (name: string) => `节点返回“${name}”时继续执行。`

/** 按给定结果名同步三级小节：保留同名正文，追加缺失项，删除多余项。 */
export function setResults(section: FlowSection, names: string[]): FlowSection {
  const { prefix, blocks } = partition(section.body)
  const text = names
    .map((name) => `### ${name}\n\n${blocks.get(name)?.[0] || resultPlaceholder(name)}`)
    .join('\n\n')
  return { ...section, body: (prefix + (text ? `\n\n${text}` : '')).trimEnd() }
}

/** 同步整个包：节点名称、动作类型与结果小节跟随图结构。 */
export function syncSections(
  sections: FlowSection[],
  previous: FlowGraph,
  next: FlowGraph,
  kinds: Map<string, ActionKind> = new Map(),
): FlowSection[] {
  const graph = next
  // 节点改名时按引用名找回原小节，正文（提示词、结果说明）不能丢。
  const previousNames = new Map(previous.nodes.map((node) => [node.ref, node.name]))
  const byName = new Map(sections.map((section) => [section.name, section]))
  // 开始、结束和并行点只是图上的控制点，没有对应小节。
  const nodes = graph.nodes.filter((node) => node.kind === 'work')
  const active = new Set(nodes.map((node) => node.ref))
  const build = (node: (typeof nodes)[number]): FlowSection => {
    const old = byName.get(previousNames.get(node.ref) ?? node.name)
    let section: FlowSection = { name: node.name, body: old?.body ?? '' }
    const kind = node.actionKind ?? kinds.get(node.ref) ?? actionOf(section)?.kind ?? '新建Agent'
    section = setAction(section, kind)
    return setResults(
      section,
      graph.edges
        .filter((edge) => edge.from === node.ref && edge.result)
        .map((edge) => edge.result as string),
    )
  }
  // 保留既有小节的文档顺序，新增节点追加到末尾，删除节点的正文随节点消失。
  const result: FlowSection[] = []
  const emitted = new Set<string>()
  for (const section of sections) {
    const node = nodes.find(
      (candidate) => candidate.name === section.name || previousNames.get(candidate.ref) === section.name,
    )
    if (!node || !active.has(node.ref) || emitted.has(node.ref)) continue
    emitted.add(node.ref)
    result.push(build(node))
  }
  for (const node of nodes) if (!emitted.has(node.ref)) result.push(build(node))
  return result
}
