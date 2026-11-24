// 运行流转图：只读画布，按运行事实标出节点状态、实际走过的边与当前节点。
// 布局与卡片尺寸复用编辑画布的 layout.ts 与 cnode 样式，位置只存在界面里。
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { BellRing, CirclePlay, Command, Copy, Flag, GitBranch, Layers, Sparkles } from 'lucide-react'
import type { ActionKind, FlowGraph, GraphNode } from './flow/graph'
import type { RunFlowState, RunNodeStatus } from './flow/run-state'
import { layoutGraph, nodeSize, type Point } from './flow/layout'
import { edgeGeometry } from './flow/edge'

const kindIcon: Record<ActionKind, typeof Sparkles> = {
  新建Agent: Sparkles,
  复用Agent: Copy,
  执行自定义命令: Command,
  执行Flow: Layers,
  confirm: BellRing,
}
const statusLabels: Record<RunNodeStatus, string> = {
  pending: '未到达',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
}
const toneOf = (result: string) => {
  if (/失败|无法|未通过|返工|重做|错误/.test(result)) return 'err'
  if (/通过|完成|已|结束|成功/.test(result)) return 'ok'
  return 'default'
}

interface NodeData {
  node: GraphNode
  status: RunNodeStatus
  visits: number
  detail?: string
  current: boolean
  selected: boolean
  actionKind?: string
  results: { id: string; result?: string; targetName: string }[]
  onSelect: () => void
}

const StatusDot = ({ status }: { status: RunNodeStatus }) => (
  <i className={`rnode-dot status-${status}`} aria-label={statusLabels[status]} />
)

const RunWorkNode = memo(function RunWorkNode({ data }: NodeProps) {
  const item = data as unknown as NodeData
  const Icon = kindIcon[(item.actionKind as ActionKind) ?? '新建Agent'] ?? Sparkles
  return (
    <div
      className={'cnode rnode' + (item.current ? ' is-current' : '') + (item.selected ? ' is-selected' : '')}
      data-run-status={item.status}
      data-node-type={item.actionKind ?? '未设置'}
      onClick={item.onSelect}
    >
      <Handle type="target" position={Position.Left} className="cport cport--in" />
      <div className="cnode-head">
        <span className="cnode-icon">
          <Icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="cnode-title">{item.node.name}</span>
          <span className="cnode-sub">
            <StatusDot status={item.status} />
            {statusLabels[item.status]}
            {item.visits > 1 ? ` · ${item.visits} 次` : ''}
            {item.current ? ' · 当前' : ''}
          </span>
        </span>
      </div>
      <div className="cnode-body">
        <span className="cnode-goal">{item.detail || item.actionKind || '没有执行记录'}</span>
      </div>
      <div className="cnode-outlets">
        {item.results.length ? (
          item.results.map((result) => (
            <div key={result.id} className={`cnode-outlet tone-${toneOf(result.result ?? '')}`}>
              <span className="cnode-outlet-label">{result.result ?? '直接流转'}</span>
              <span className="cnode-outlet-target">{result.targetName}</span>
              <Handle type="source" position={Position.Right} id={result.result ?? 'out'} className="cport" />
            </div>
          ))
        ) : (
          <div className="cnode-outlet is-empty">
            <span className="cnode-outlet-label">没有出边</span>
            <Handle type="source" position={Position.Right} id="out" className="cport" />
          </div>
        )}
      </div>
    </div>
  )
})

const RunTerminalNode = memo(function RunTerminalNode({ data }: NodeProps) {
  const item = data as unknown as NodeData
  return (
    <div
      className={
        'cterminal rnode' + (item.current ? ' is-current' : '') + (item.selected ? ' is-selected' : '')
      }
      data-run-status={item.status}
      onClick={item.onSelect}
    >
      {item.node.kind === 'finish' && <Handle type="target" position={Position.Left} className="cport cport--in" />}
      <span className="cterminal-icon">
        {item.node.kind === 'start' ? <CirclePlay size={15} /> : <Flag size={15} />}
      </span>
      {item.node.name}
      {item.node.kind === 'start' && <Handle type="source" position={Position.Right} id="out" className="cport" />}
    </div>
  )
})

const RunParallelNode = memo(function RunParallelNode({ data }: NodeProps) {
  const item = data as unknown as NodeData
  return (
    <div
      className={
        'cparallel rnode' + (item.current ? ' is-current' : '') + (item.selected ? ' is-selected' : '')
      }
      data-run-status={item.status}
      onClick={item.onSelect}
    >
      <Handle type="target" position={Position.Left} className="cport cport--in" />
      <GitBranch size={14} />
      {item.node.name}
      {item.visits > 0 && <span className="rnode-count">{item.visits}</span>}
      <Handle type="source" position={Position.Right} id="out" className="cport" />
    </div>
  )
})

const RunEdge = memo(function RunEdge(props: EdgeProps) {
  const data = props.data as unknown as { traversed: number; points?: Point[] }
  const { path } = edgeGeometry(props, data?.points ?? [])
  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={props.markerEnd}
      className={data?.traversed ? 'cedge-path is-taken' : 'cedge-path is-idle'}
    />
  )
})

const nodeTypes = { work: RunWorkNode, start: RunTerminalNode, finish: RunTerminalNode, parallel: RunParallelNode }
const edgeTypes = { result: RunEdge }

export function RunGraph({
  graph,
  actionKinds,
  state,
  selected,
  onSelect,
}: {
  graph: FlowGraph
  /** 节点引用名 → 动作类型；来自 FLOW.md 的节点小节。 */
  actionKinds: Record<string, ActionKind | undefined>
  state: RunFlowState
  selected?: string
  onSelect: (ref: string) => void
}) {
  const area = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<ReactFlowInstance | null>(null)
  const layout = useMemo(() => layoutGraph(graph), [graph])

  const finishStatus = (): RunNodeStatus => {
    if (state.runStatus === 'completed') return 'completed'
    if (state.runStatus === 'failed') return 'failed'
    if (state.runStatus === 'interrupted') return 'interrupted'
    return 'pending'
  }
  const statusOf = (ref: string, node: GraphNode): RunNodeStatus => {
    const known = state.nodes[ref]?.status
    if (known) return known
    if (node.kind === 'start') return state.runStatus ? 'completed' : 'pending'
    if (node.kind === 'finish') return finishStatus()
    return 'pending'
  }

  const nodes: Node[] = useMemo(
    () =>
      graph.nodes.map((node) => ({
        id: node.ref,
        type: node.kind,
        position: layout.positions[node.ref] ?? { x: 0, y: 0 },
        draggable: false,
        selected: selected === node.ref,
        data: {
          node,
          status: statusOf(node.ref, node),
          visits: state.nodes[node.ref]?.visits ?? 0,
          detail: state.nodes[node.ref]?.lastResult,
          current: state.currentRef === node.ref,
          selected: selected === node.ref,
          actionKind: actionKinds[node.ref],
          results: graph.edges
            .filter((edge) => edge.from === node.ref)
            .map((edge) => ({
              id: edge.id,
              result: edge.result,
              targetName: graph.nodes.find((item) => item.ref === edge.to)?.name ?? edge.to,
            })),
          onSelect: () => onSelect(node.ref),
        },
      })),
    [graph, layout, state, selected, actionKinds, onSelect],
  )

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => {
        const run = state.edges[edge.id]
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          sourceHandle: edge.result ?? 'out',
          type: 'result',
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color: run ? '#7b61ff' : '#9494a0',
          },
          data: { traversed: run?.traversed ?? 0, points: layout.routes[edge.id] ?? [] },
        }
      }),
    [graph, layout, state],
  )

  const fit = useCallback(() => {
    const instance = canvas.current
    const element = area.current
    if (!instance || !element || !graph.nodes.length) return
    const boxes = graph.nodes.map((node) => {
      const point = layout.positions[node.ref] ?? { x: 0, y: 0 }
      return { ...point, ...nodeSize(node, graph) }
    })
    const minX = Math.min(...boxes.map((box) => box.x))
    const minY = Math.min(...boxes.map((box) => box.y))
    const width = Math.max(...boxes.map((box) => box.x + box.width)) - minX
    const height = Math.max(...boxes.map((box) => box.y + box.height)) - minY
    const pad = 24
    const zoom = Math.max(
      0.6,
      Math.min((element.clientWidth - pad * 2) / width, (element.clientHeight - pad * 2) / height, 1),
    )
    const x =
      width * zoom <= element.clientWidth - pad * 2
        ? (element.clientWidth - width * zoom) / 2 - minX * zoom
        : pad - minX * zoom
    const y = Math.max(pad, (element.clientHeight - height * zoom) / 2) - minY * zoom
    instance.setViewport({ x, y, zoom }, { duration: 200 })
  }, [graph, layout])
  useEffect(() => {
    fit()
  }, [fit])

  return (
    <div className="runflow">
      <div className="canvas-area runflow-area" ref={area}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          minZoom={0.2}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          onInit={(instance) => {
            canvas.current = instance
            fit()
          }}
        >
          <Background gap={18} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <ul className="runflow-legend" aria-label="节点状态图例">
        {(['running', 'completed', 'failed', 'pending'] as RunNodeStatus[]).map((status) => (
          <li key={status}>
            <StatusDot status={status} />
            {statusLabels[status]}
          </li>
        ))}
        <li>
          <span className="runflow-legend-line" />
          已走过
        </li>
      </ul>
    </div>
  )
}
