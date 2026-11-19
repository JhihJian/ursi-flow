// FLOW.md 的图形模型：Mermaid 图语句 ⇄ 节点与结果边。只解析 Flow 规范定义的子集。
export type ActionKind = '新建Agent' | '复用Agent' | '执行自定义命令' | '执行Flow'
export const ACTION_KINDS: ActionKind[] = ['新建Agent', '复用Agent', '执行自定义命令', '执行Flow']
export type NodeKind = 'start' | 'finish' | 'work' | 'parallel'

export interface GraphNode {
  ref: string
  name: string
  kind: NodeKind
  actionKind?: ActionKind
}
export interface GraphEdge {
  id: string
  from: string
  to: string
  /** 结果名。并行分支与执行Flow 的直连边没有结果名。 */
  result?: string
}
export interface FlowGraph {
  directive: string
  comments: string[]
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const edgeId = (from: string, result: string | undefined, to: string) =>
  `${from}|${result ?? ''}|${to}`

export const START = 'start'
export const FINISH = 'finish'
export const START_NAME = '开始'
export const FINISH_NAME = '结束'

interface Endpoint {
  ref: string
  name?: string
  kind?: NodeKind | 'terminal'
}
// 端点：ref[名称] / ref{{并行}} / start((开始)) / finish((结束)) / 裸 ref
function endpoint(text: string): Endpoint {
  const value = text.trim()
  let match: RegExpMatchArray | null
  if ((match = value.match(/^([A-Za-z0-9_][\w-]*)\[([^\]]*)\]$/)))
    return { ref: match[1], name: match[2].trim(), kind: 'work' }
  if ((match = value.match(/^([A-Za-z0-9_][\w-]*)\{\{([^}]*)\}\}$/)))
    return { ref: match[1], name: match[2].trim() || '并行', kind: 'parallel' }
  if ((match = value.match(/^([A-Za-z0-9_][\w-]*)\(\(([^)]*)\)\)$/)))
    return { ref: match[1], name: match[2].trim(), kind: 'terminal' }
  if ((match = value.match(/^([A-Za-z0-9_][\w-]*)$/)))
    return { ref: match[1] }
  throw new Error(`无法解析的图节点：${value}`)
}

export function parseGraph(text: string): FlowGraph {
  const lines = text.split('\n')
  const comments: string[] = []
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  let directive = ''
  let graphDone = false
  const define = (item: Endpoint): string => {
    const ref = item.ref
    const known = nodes.get(ref)
    if (!known) {
      const kind: NodeKind =
        ref === START
          ? 'start'
          : ref === FINISH
            ? 'finish'
            : item.kind === 'parallel'
              ? 'parallel'
              : 'work'
      nodes.set(ref, {
        ref,
        name: item.name || (kind === 'start' ? START_NAME : kind === 'finish' ? FINISH_NAME : ref),
        kind,
      })
    } else if (item.name) known.name = item.name
    return ref
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('%%')) {
      // 图语句开始之前的注释是作者写给读者的说明，序列化时保留。
      if (!graphDone) comments.push(line)
      continue
    }
    if (!directive) {
      if (!/^flowchart\b/.test(line)) throw new Error('缺少 flowchart 图声明')
      directive = line
      continue
    }
    graphDone = true
    const parts = line.split('-->')
    if (parts.length < 2) {
      define(endpoint(line))
      continue
    }
    let from = define(endpoint(parts[0]))
    for (let i = 1; i < parts.length; i++) {
      const segment = parts[i]
      const labeled = segment.match(/^\s*\|([^|]*)\|\s*(.+)$/)
      const result = labeled ? labeled[1].trim() : undefined
      const to = define(endpoint(labeled ? labeled[2] : segment))
      edges.push({ id: edgeId(from, result, to), from, to, ...(result ? { result } : {}) })
      from = to
    }
  }
  if (!directive) throw new Error('缺少 flowchart 图声明')
  return { directive, comments, nodes: [...nodes.values()], edges }
}

const declaration = (node: GraphNode) => {
  if (node.kind === 'start') return `${node.ref}((${node.name || START_NAME}))`
  if (node.kind === 'finish') return `${node.ref}((${node.name || FINISH_NAME}))`
  if (node.kind === 'parallel') return `${node.ref}{{${node.name || '并行'}}}`
  return `${node.ref}[${node.name}]`
}

export function serializeGraph(graph: FlowGraph): string {
  const declared = new Set<string>()
  const lines: string[] = [graph.directive || 'flowchart TD']
  for (const comment of graph.comments) lines.push('  ' + comment)
  const byRef = new Map(graph.nodes.map((node) => [node.ref, node]))
  const token = (ref: string) => {
    const node = byRef.get(ref)
    if (!node) return ref
    if (declared.has(ref)) return ref
    declared.add(ref)
    return declaration(node)
  }
  for (const edge of graph.edges)
    lines.push(
      `  ${token(edge.from)} -->${edge.result ? `|${edge.result}|` : ''} ${token(edge.to)}`,
    )
  for (const node of graph.nodes) if (!declared.has(node.ref)) lines.push(`  ${token(node.ref)}`)
  return lines.join('\n')
}

/** 每个源节点的出边分组，按结果名排序，用于卡片上的出口与连线。 */
export function outgoing(graph: FlowGraph, ref: string): GraphEdge[] {
  return graph.edges.filter((edge) => edge.from === ref)
}
export function incoming(graph: FlowGraph, ref: string): GraphEdge[] {
  return graph.edges.filter((edge) => edge.to === ref)
}
export const nodeOf = (graph: FlowGraph, ref: string) =>
  graph.nodes.find((node) => node.ref === ref)

/** 图结构检查。返回面向作者的中文问题列表，空数组表示结构可用。 */
export function graphIssues(graph: FlowGraph): string[] {
  const issues: string[] = []
  const refs = new Set(graph.nodes.map((node) => node.ref))
  const names = new Map<string, number>()
  for (const node of graph.nodes)
    names.set(node.name, (names.get(node.name) || 0) + 1)
  for (const [name, count] of names)
    if (count > 1) issues.push(`节点名称重复：${name}`)
  if (!refs.has(START)) issues.push('缺少开始节点')
  else {
    const outs = outgoing(graph, START)
    if (outs.length !== 1) issues.push('开始节点必须只有一条出边')
    if (outs.some((edge) => edge.result)) issues.push('开始节点的出边不能带结果名')
  }
  if (!refs.has(FINISH)) issues.push('缺少结束节点')
  else if (outgoing(graph, FINISH).length) issues.push('结束节点不能有出边')
  for (const node of graph.nodes) {
    if (node.ref === START || node.ref === FINISH) continue
    const outs = outgoing(graph, node.ref)
    if (!outs.length) {
      issues.push(`${node.name} 没有出边`)
      continue
    }
    if (node.kind === 'parallel') {
      if (outs.some((edge) => edge.result)) issues.push(`${node.name} 的并行分支不能带结果名`)
      if (outs.length < 2) issues.push(`${node.name} 至少要两条并行分支`)
      continue
    }
    const labeled = outs.filter((edge) => edge.result)
    if (labeled.length && labeled.length !== outs.length)
      issues.push(`${node.name} 的出边混用了带结果与直连`)
    if (node.actionKind === '执行Flow' && labeled.length === 0 && outs.length !== 1)
      issues.push(`${node.name} 作为执行Flow 只能有一条直连边或两条结果边`)
    const results = labeled.map((edge) => edge.result as string)
    if (new Set(results).size !== results.length)
      issues.push(`${node.name} 的结果名重复`)
  }
  return issues
}

/** 深拷贝，供界面做不可变编辑。 */
export function cloneGraph(graph: FlowGraph): FlowGraph {
  return {
    directive: graph.directive,
    comments: [...graph.comments],
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  }
}

/** 生成未占用的节点引用名。 */
export function nextRef(graph: FlowGraph, base = 'node'): string {
  const used = new Set(graph.nodes.map((node) => node.ref))
  for (let i = 1; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`
}
export function nextName(graph: FlowGraph, base: string): string {
  const used = new Set(graph.nodes.map((node) => node.name))
  if (!used.has(base)) return base
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`
}
