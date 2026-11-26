import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  FlowDefinition,
  FlowDestination,
  FlowValue,
} from 'ursi-flow/core/runtime'
import { parseFlow } from 'ursi-flow/core/runtime'

export type FlowNodeKind = 'agent' | 'confirm' | 'command'

export interface FlowVariableView {
  name: string
  description: string
  /** 没有默认值时必须由启动变量提供。 */
  required: boolean
  default?: FlowValue
}

export interface FlowOutcomeView {
  name: string
  description: string
  destination: { kind: 'node' | 'parallel' | 'finish'; ref?: string; name?: string }
}

export interface FlowNodeView {
  ref: string
  name: string
  kind: FlowNodeKind
  /** Agent 提示词或确认正文；命令节点为空。 */
  prompt?: string
  /** 命令节点的请求模板，变量占位符保留原样。 */
  request?: unknown
  outcomes: FlowOutcomeView[]
}

export interface FlowParallelView {
  ref: string
  branches: string[]
  joinRef: string
  joinName: string
}

export interface FlowSummary {
  /** 包目录名，也是 Flow 标识。 */
  id: string
  dir: string
  name: string
  description: string
  nodeCount: number
  variableCount: number
  valid: boolean
  error?: string
}

export interface FlowDetail extends FlowSummary {
  path: string
  /** 起始节点引用，图从它开始排。 */
  startNodeRef: string
  variables: FlowVariableView[]
  nodes: FlowNodeView[]
  parallels: FlowParallelView[]
}

/** Flow 标识就是包目录名，因此不允许出现路径分隔符与上跳。 */
const FLOW_ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u

export function assertFlowId(id: string): void {
  if (!FLOW_ID.test(id) || id === '.' || id === '..')
    throw new Error(`非法的 Flow 标识：${id}`)
}

export async function listFlows(home: string): Promise<FlowSummary[]> {
  const entries = await readdir(home, { withFileTypes: true }).catch(() => [])
  const flows: FlowSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (!(await isFlowPackage(join(home, entry.name)))) continue
    flows.push(await readFlow(home, entry.name))
  }
  return flows.sort((left, right) => left.id.localeCompare(right.id, 'zh-Hans-CN'))
}

async function isFlowPackage(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'FLOW.md'))).isFile()
  } catch {
    return false
  }
}

/** 读取并解析一个 Flow 包。解析失败也返回摘要，让界面能标出是哪一份坏了。 */
export async function readFlow(home: string, id: string): Promise<FlowDetail> {
  assertFlowId(id)
  const dir = join(home, id)
  const path = join(dir, 'FLOW.md')
  const base: FlowDetail = {
    id,
    dir,
    path,
    startNodeRef: '',
    name: id,
    description: '',
    nodeCount: 0,
    variableCount: 0,
    valid: false,
    variables: [],
    nodes: [],
    parallels: [],
  }
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined)
    return { ...base, error: `缺少 FLOW.md：${path}` }
  try {
    return describe(parseFlow(text, id), base)
  } catch (error) {
    return { ...base, error: messageOf(error) }
  }
}

function describe(flow: FlowDefinition, base: FlowDetail): FlowDetail {
  const variables: FlowVariableView[] = Object.entries(flow.variables ?? {}).map(
    ([name, declaration]) => ({
      name,
      description: declaration.description,
      required: declaration.default === undefined,
      ...(declaration.default === undefined ? {} : { default: declaration.default }),
    }),
  )
  const nodes: FlowNodeView[] = [...flow.nodes.values()].map((node) => ({
    ref: node.ref,
    name: node.name,
    kind:
      node.action.kind === '执行自定义命令'
        ? 'command'
        : node.action.kind === 'confirm'
          ? 'confirm'
          : 'agent',
    ...(node.action.kind === '执行自定义命令'
      ? { request: node.action.request }
      : { prompt: node.action.prompt }),
    outcomes: [...node.results].map(([name, description]) => ({
      name,
      description,
      destination: destinationOf(node.successors.get(name), flow),
    })),
  }))
  const parallels: FlowParallelView[] = [...flow.parallels.values()].map(
    (parallel) => ({
      ref: parallel.ref,
      branches: [...parallel.branches],
      joinRef: parallel.joinRef,
      joinName: flow.nodes.get(parallel.joinRef)?.name ?? parallel.joinRef,
    }),
  )
  return {
    ...base,
    startNodeRef: flow.startNodeRef,
    name: flow.name,
    description: flow.description,
    valid: true,
    variableCount: variables.length,
    nodeCount: nodes.length,
    variables,
    nodes,
    parallels,
  }
}

function destinationOf(
  destination: FlowDestination | undefined,
  flow: FlowDefinition,
): FlowOutcomeView['destination'] {
  if (destination === undefined) return { kind: 'finish' }
  if (destination.kind === 'finish') return { kind: 'finish' }
  if (destination.kind === 'parallel')
    return { kind: 'parallel', ref: destination.ref }
  return {
    kind: 'node',
    ref: destination.ref,
    name: flow.nodes.get(destination.ref)?.name ?? destination.ref,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
