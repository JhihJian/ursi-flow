import { pinned, sameRef, type Collection, type Definition, type Executor, type ExecutorKind, type Ports, type Ref, type ResourceKind } from './catalog'

export type FieldRow = { name: string; type: string }
export type ActionDraft = { name: string; executor: Ref; resources: Ref[]; inputs?: FieldRow[]; outputs?: FieldRow[] }
export const blankRef = (): Ref => ({ id: '', revision: 0 })
export const blankAction = (): ActionDraft => ({ name: '', executor: blankRef(), resources: [] })
export type Draft = {
  id: string; resourceKind: ResourceKind; text: string; serverRef: string; credentialRef: string
  executorKind: ExecutorKind; environment: string; flowId: string; flowRevision: string
  resources: Ref[]; inputs?: FieldRow[]; outputs?: FieldRow[]
  sop: string; acceptance: string; goal?: string; structuredGoal: boolean; deliverables?: string; actions: ActionDraft[]
}
const rows = (p?: Ports) => p && Object.entries(p).map(([name, type]) => ({ name, type }))
export function initialDraft(v?: Definition, executors: Executor[] = []): Draft {
  const d: Draft = {
    id: v?.id ?? '', resourceKind: 'skill', text: '', serverRef: '', credentialRef: '',
    executorKind: 'agent', environment: '', flowId: '', flowRevision: '', resources: [],
    sop: '', acceptance: '', structuredGoal: false, actions: [blankAction()],
  }
  if (!v) return d
  if ('content' in v) {
    d.resourceKind = v.kind
    if (typeof v.content === 'string') d.text = v.content
    else { d.serverRef = v.content.serverRef; d.credentialRef = v.content.credentialRef ?? '' }
    return d
  }
  d.inputs = rows(v.inputs); d.outputs = rows(v.outputs); d.resources = (v.resources ?? []).map(pinned)
  if ('actions' in v) {
    d.sop = v.sop; d.acceptance = v.acceptance; d.deliverables = v.deliverables?.join('\n')
    d.structuredGoal = v.goal !== undefined && typeof v.goal !== 'string'
    d.goal = d.structuredGoal ? JSON.stringify(v.goal, null, 2) : v.goal as string | undefined
    d.actions = Object.entries(v.actions).map(([name, a]) => {
      const exec = executors.find(e => sameRef(e, a.executor))
      if (!exec) throw new Error(`缺少执行器 ${a.executor.id} v${a.executor.revision}，无法还原动作。`)
      const inherited = [...d.resources, ...(exec.resources ?? [])]
      return { name, executor: pinned(a.executor), resources: a.resources.filter(r => !inherited.some(i => sameRef(r, i))).map(pinned) }
    })
  } else {
    d.executorKind = v.kind; d.environment = v.environment ?? ''; d.flowId = v.flowId ?? ''; d.flowRevision = v.flowRevision ?? ''
  }
  return d
}
function fields(portRows?: FieldRow[]) {
  if (!portRows) return undefined
  if (new Set(portRows.map(p => p.name)).size !== portRows.length) throw new Error('声明中有重复字段名。')
  return Object.fromEntries(portRows.map(p => [p.name, p.type]))
}
function fixed(ref: Ref) {
  if (!ref.id || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('请选择固定的引用版本。')
  return pinned(ref)
}
export function publishBody(k: Collection, d: Draft) {
  const id = d.id
  if (k === 'resources') return { id, kind: d.resourceKind, content: d.resourceKind === 'mcp'
    ? { serverRef: d.serverRef, credentialRef: d.credentialRef || undefined } : d.text }
  const io = { inputs: fields(d.inputs), outputs: fields(d.outputs) }
  if (k === 'executors') return d.executorKind === 'flow'
    ? { id, kind: 'flow', flowId: d.flowId, flowRevision: d.flowRevision, ...io }
    : { id, kind: 'agent', environment: d.environment || undefined, resources: d.resources.map(fixed), ...io }
  if (!d.actions.length || new Set(d.actions.map(a => a.name)).size !== d.actions.length) throw new Error('至少需要一个动作，且动作名称不能重复。')
  return { id, sop: d.sop, acceptance: d.acceptance, goal: d.structuredGoal ? JSON.parse(d.goal ?? '') : d.goal,
    deliverables: d.deliverables === '' ? [] : d.deliverables?.split('\n'), resources: d.resources.map(fixed), ...io,
    actions: Object.fromEntries(d.actions.map(a => [a.name, { executor: fixed(a.executor), resources: a.resources.map(fixed), inputs: fields(a.inputs), outputs: fields(a.outputs) }])),
  }
}
