// 图形视图：FLOW.md 的节点卡片、结果边与检查器。参照工作台与 grasp 的画布样式。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  applyNodeChanges,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Boxes,
  CirclePlay,
  Command,
  Copy,
  CornerDownRight,
  Flag,
  GitBranch,
  Layers,
  ListTree,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { ACTION_KINDS, type ActionKind, type FlowGraph, type GraphNode, incoming } from './flow/graph'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'
import { Select } from './components/ui/select'
import { Textarea } from './components/ui/textarea'
import { layoutGraph, nodeSize, type Point } from './flow/layout'
import { edgeGeometry } from './flow/edge'
import { fixedOutgoing } from './flow/edit'
import { actionOf, type FlowSection } from './flow/doc'
import {
  addNode,
  addResult,
  canAddOutgoing,
  connect,
  removeEdge,
  removeNode,
  renameResult,
  retargetEdge,
} from './flow/edit'

export interface Selection {
  kind: 'node' | 'edge'
  id: string
}

export interface CanvasProps {
  graph: FlowGraph
  sections: FlowSection[]
  issues: string[]
  onGraph: (next: FlowGraph) => void
  onAction: (ref: string, change: { kind?: ActionKind; body?: string }) => void
  onStart: () => void
}

const kindIcon: Record<ActionKind, typeof Sparkles> = {
  新建Agent: Sparkles,
  复用Agent: Copy,
  执行自定义命令: Command,
  执行Flow: Layers,
}
/** 结果名的语气：失败类偏红，完成类偏绿，其余中性。 */
const toneOf = (result: string) => {
  if (/失败|无法|未通过|返工|重做|错误/.test(result)) return 'err'
  if (/通过|完成|已|结束|成功/.test(result)) return 'ok'
  return 'default'
}
const promptPreview = (body?: string) =>
  (body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('{') && !line.startsWith('}'))
    .slice(0, 2)
    .join(' ')
    .slice(0, 90)

const WorkNode = memo(function WorkNode({ data, selected }: NodeProps) {
  const { node, results, actions, onSelect } = data as unknown as {
    node: GraphNode
    results: { id: string; result?: string; targetName: string }[]
    actions: { kind: ActionKind; body: string } | null
    onSelect: () => void
  }
  const Icon = kindIcon[actions?.kind ?? '新建Agent'] ?? Sparkles
  return (
    <div
      className={'cnode' + (selected ? ' is-selected' : '')}
      data-node-type={actions?.kind ?? '未设置'}
      onClick={onSelect}
    >
      <Handle type="target" position={Position.Left} className="cport cport--in" />
      <div className="cnode-head">
        <span className="cnode-icon">
          <Icon size={15} />
        </span>
        <span className="min-w-0">
          <span className="cnode-title">{node.name}</span>
          <span className="cnode-sub">{actions?.kind ?? '缺少动作块'}</span>
        </span>
      </div>
      <div className="cnode-body">
        <span className="cnode-goal">{promptPreview(actions?.body) || '尚未填写节点内容'}</span>
      </div>
      <div className="cnode-outlets">
        {results.length ? (
          results.map((item) => (
            <div key={item.id} className={`cnode-outlet tone-${toneOf(item.result ?? '')}`}>
              <span className="cnode-outlet-label">{item.result ?? '直接流转'}</span>
              <span className="cnode-outlet-target">{item.targetName}</span>
              <Handle type="source" position={Position.Right} id={item.result ?? 'out'} className="cport" />
            </div>
          ))
        ) : (
          <div className="cnode-outlet is-empty">
            <span className="cnode-outlet-label">没有结果边</span>
            <Handle type="source" position={Position.Right} id="out" className="cport" />
          </div>
        )}
      </div>
    </div>
  )
})

const TerminalNode = memo(function TerminalNode({ data, selected }: NodeProps) {
  const { node, onSelect } = data as unknown as { node: GraphNode; onSelect: () => void }
  return (
    <div className={'cterminal' + (selected ? ' is-selected' : '')} onClick={onSelect}>
      {node.kind === 'finish' && <Handle type="target" position={Position.Left} className="cport cport--in" />}
      <span className="cterminal-icon">
        {node.kind === 'start' ? <CirclePlay size={15} /> : <Flag size={15} />}
      </span>
      {node.name}
      {node.kind === 'start' && <Handle type="source" position={Position.Right} id="out" className="cport" />}
    </div>
  )
})

const ParallelNode = memo(function ParallelNode({ data, selected }: NodeProps) {
  const { node, onSelect } = data as unknown as { node: GraphNode; onSelect: () => void }
  return (
    <div className={'cparallel' + (selected ? ' is-selected' : '')} onClick={onSelect}>
      <Handle type="target" position={Position.Left} className="cport cport--in" />
      <GitBranch size={14} />
      {node.name}
      <Handle type="source" position={Position.Right} id="out" className="cport" />
    </div>
  )
})

const ResultEdge = memo(function ResultEdge(props: EdgeProps) {
  const data = props.data as unknown as { result?: string; selected?: boolean; points?: Point[] }
  const tone = data?.result ? toneOf(data.result) : 'default'
  const { path, label } = edgeGeometry(props, data?.points ?? [])
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        className={
          'cedge-path' + (data?.result ? ` tone-${tone}` : '') + (data?.selected ? ' is-selected' : '')
        }
      />
      {/* 结果名已标在来源卡片的出口行上，画布只在选中时再显示一次，避免密集连线被标签遮挡。 */}
      {data?.result && data?.selected && (
        <EdgeLabelRenderer>
          <div
            className={`cedge-label tone-${tone} nodrag nopan`}
            style={{ transform: `translate(0,-50%) translate(${label.x + 4}px,${label.y}px)` }}
          >
            {data.result}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

const nodeTypes = { work: WorkNode, start: TerminalNode, finish: TerminalNode, parallel: ParallelNode }
const edgeTypes = { result: ResultEdge }

export function FlowCanvas({ graph, sections, issues, onGraph, onAction, onStart }: CanvasProps) {
  // 节点位置由 React Flow 自己维护，拖拽时只更新被拖的节点，不回到上层重算布局。
  const [nodes, setNodes] = useState<Node[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [showMinimap, setShowMinimap] = useState(true)
  const canvas = useRef<ReactFlowInstance | null>(null)
  const area = useRef<HTMLDivElement | null>(null)
  // 用户拖过的位置记在引用里，结构变化重建节点时保留，不必触发渲染。
  const moved = useRef<Record<string, { x: number; y: number }>>({})

  const sectionOf = useCallback(
    (node: GraphNode) => sections.find((section) => section.name === node.name),
    [sections],
  )
  const selectNode = useCallback(
    (ref: string) => () => setSelection({ kind: 'node', id: ref }),
    [],
  )

  const layout = useMemo(() => layoutGraph(graph), [graph])
  // 图比视口宽时不强行缩小到看不清：保持可读缩放，并把视图贴到流程起点一侧。
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
    const zoom = Math.max(0.6, Math.min((element.clientWidth - pad * 2) / width, (element.clientHeight - pad * 2) / height, 1))
    const x = width * zoom <= element.clientWidth - pad * 2 ? (element.clientWidth - width * zoom) / 2 - minX * zoom : pad - minX * zoom
    const y = Math.max(pad, (element.clientHeight - height * zoom) / 2) - minY * zoom
    instance.setViewport({ x, y, zoom }, { duration: 200 })
  }, [graph, layout])
  // 只在结构或选中状态变化时重建节点；data 引用稳定，节点组件用 memo 跳过无谓渲染。
  useEffect(() => {
    setNodes((current) => {
      const previous = new Map(current.map((node) => [node.id, node]))
      return graph.nodes.map((node) => {
        const before = previous.get(node.ref)
        const position =
          moved.current[node.ref] ?? before?.position ?? layout.positions[node.ref] ?? { x: 0, y: 0 }
        return {
          id: node.ref,
          type: node.kind,
          position,
          selected: selection?.kind === 'node' && selection.id === node.ref,
          data: {
            node,
            results: graph.edges
              .filter((edge) => edge.from === node.ref)
              .map((edge) => ({
                id: edge.id,
                result: edge.result,
                targetName: graph.nodes.find((item) => item.ref === edge.to)?.name ?? edge.to,
              })),
            actions: (() => {
              const section = sectionOf(node)
              return section ? actionOf(section) : null
            })(),
            onSelect: selectNode(node.ref),
          },
        }
      })
    })
  }, [graph, layout, selection, sectionOf, selectNode])

  // 图变化后只清理指向已删除元素的选择，新增节点时保留刚建立的选中状态。
  useEffect(() => {
    setSelection((current) => {
      if (!current) return current
      const exists =
        current.kind === 'node'
          ? graph.nodes.some((node) => node.ref === current.id)
          : graph.edges.some((edge) => edge.id === current.id)
      return exists ? current : null
    })
  }, [graph])
  useEffect(() => setPrompt(null), [selection?.id])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes)
      if (change.type === 'position' && change.position) moved.current[change.id] = change.position
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => {
        const tone = edge.result ? toneOf(edge.result) : 'default'
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
            color:
              tone === 'ok'
                ? 'rgb(22 128 61)'
                : tone === 'err'
                  ? 'rgb(220 38 38)'
                  : 'rgb(148 148 160)',
          },
          data: {
            result: edge.result,
            selected: selection?.kind === 'edge' && selection.id === edge.id,
            points: layout.routes[edge.id] ?? [],
          },
        }
      }),
    [graph, selection, layout],
  )

  const autoLayout = useCallback(() => {
    moved.current = {}
    setNodes((current) =>
      current.map((node) => ({ ...node, position: layout.positions[node.id] ?? node.position })),
    )
    fit()
  }, [layout, fit])

  const connectEdge = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      onGraph(connect(graph, connection.source, connection.target, connection.sourceHandle))
      setSelection(null)
    },
    [graph, onGraph],
  )
  // 结构变化后重新适配视图，避免新增节点落在可视区外。
  const structure = useMemo(
    () => graph.nodes.map((node) => node.ref).join('|') + '#' + graph.edges.map((edge) => edge.id).join('|'),
    [graph],
  )
  useEffect(() => {
    fit()
  }, [structure, fit])

  const selectedNode =
    selection?.kind === 'node' ? graph.nodes.find((node) => node.ref === selection.id) : undefined
  const selectedEdge =
    selection?.kind === 'edge' ? graph.edges.find((edge) => edge.id === selection.id) : undefined

  const add = (kind: 'work' | 'parallel', actionKind?: ActionKind) => {
    const created = addNode(graph, kind)
    const node = actionKind ? { ...created.node, actionKind } : created.node
    onGraph({
      ...created.graph,
      nodes: created.graph.nodes.map((item) => (item.ref === node.ref ? node : item)),
    })
    setSelection({ kind: 'node', id: node.ref })
  }

  return (
    <div className="canvas-shell">
      <div className="canvas-toolbar" role="toolbar" aria-label="添加节点">
        <span className="toolbar-label">
          <Boxes size={13} />
          添加
        </span>
        {ACTION_KINDS.map((kind) => {
          const Icon = kindIcon[kind]
          return (
            <Button
              key={kind}
              variant="ghost"
              size="icon-sm"
              onClick={() => add('work', kind)}
              title={kind}
              aria-label={kind}
            >
              <Icon />
            </Button>
          )
        })}
        <Button variant="ghost" size="icon-sm" onClick={() => add('parallel')} title="并行" aria-label="并行">
          <GitBranch />
        </Button>
        <span className="toolbar-divider" />
        <Button variant="ghost" size="icon-sm" onClick={autoLayout} title="自动布局" aria-label="自动布局">
          <ListTree />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className={showMinimap ? 'bg-accent-dim text-accent-2' : undefined}
          onClick={() => setShowMinimap(!showMinimap)}
          title="缩略图"
          aria-label="缩略图"
          aria-pressed={showMinimap}
        >
          <Layers />
        </Button>
        <span className="palette-count">{graph.nodes.length} 节点</span>
      </div>

      <div className="canvas-area" ref={area}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          elementsSelectable={false}
          deleteKeyCode={null}
          minZoom={0.2}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          onInit={(instance) => {
            canvas.current = instance
            fit()
          }}
          onNodesChange={onNodesChange}
          onConnect={connectEdge}
          connectionLineStyle={{ stroke: 'rgb(var(--c-accent))', strokeWidth: 2 }}
          onNodeClick={(_, node) => setSelection({ kind: 'node', id: node.id })}
          onEdgeClick={(_, edge) => setSelection({ kind: 'edge', id: edge.id })}
          onPaneClick={() => setSelection(null)}
        >
          <Background gap={18} size={1} />
          <Controls showInteractive={false} />
          {showMinimap && <MiniMap pannable zoomable />}
        </ReactFlow>
        {issues.length > 0 && (
          <ul className="canvas-issues" aria-label="图结构问题">
            {issues.slice(0, 4).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        {(selectedNode || selectedEdge) && (
          <aside className="canvas-inspector" aria-label="检查器">
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute right-2 top-2"
              aria-label="关闭检查器"
              onClick={() => setSelection(null)}
            >
              <X />
            </Button>
            {selectedNode ? (
              <NodeInspector
                graph={graph}
                node={selectedNode}
                section={sectionOf(selectedNode)}
                prompt={prompt}
                setPrompt={setPrompt}
                onGraph={onGraph}
                onAction={onAction}
                onStart={onStart}
              />
            ) : (
              <EdgeInspector graph={graph} id={selectedEdge!.id} onGraph={onGraph} />
            )}
          </aside>
        )}
      </div>
      {!selectedNode && !selectedEdge && (
        <p className="canvas-hint">点选节点或连线查看与修改，从卡片右侧圆点拖到目标节点可以建立结果边。</p>
      )}
    </div>
  )
}

function NodeInspector({
  graph,
  node,
  section,
  prompt,
  setPrompt,
  onGraph,
  onAction,
  onStart,
}: {
  graph: FlowGraph
  node: GraphNode
  section?: FlowSection
  prompt: string | null
  setPrompt: (value: string | null) => void
  onGraph: (next: FlowGraph) => void
  onAction: (ref: string, change: { kind?: ActionKind; body?: string }) => void
  onStart: () => void
}) {
  const actions = section ? actionOf(section) : null
  const outs = graph.edges.filter((edge) => edge.from === node.ref)
  const ins = incoming(graph, node.ref)
  const terminal = node.kind === 'start' || node.kind === 'finish'
  // 开始节点只能有一条出边，其余工作节点可以接出结果边。
  const upstream = graph.nodes.filter(
    (item) =>
      item.ref !== node.ref &&
      item.kind !== 'finish' &&
      (item.kind !== 'start' || !graph.edges.some((edge) => edge.from === item.ref)) &&
      canAddOutgoing(graph, item),
  )
  const [from, setFrom] = useState(upstream[0]?.ref ?? '')
  return (
    <div className="inspector">
      <header>
        <h2>{node.name}</h2>
        <code>{node.ref}</code>
      </header>
      {!terminal && (
        <Label className="flex-col items-stretch gap-1.5">
          节点名称
          <Input
            className="h-8 text-xs"
            value={node.name}
            onChange={(event) =>
              onGraph({
                ...graph,
                nodes: graph.nodes.map((item) =>
                  item.ref === node.ref ? { ...item, name: event.target.value } : item,
                ),
              })
            }
          />
        </Label>
      )}
      {node.kind === 'work' && (
        <Label className="flex-col items-stretch gap-1.5">
          动作
          <Select
            className="h-8 text-xs"
            value={actions?.kind ?? ''}
            onChange={(event) => onAction(node.ref, { kind: event.target.value as ActionKind })}
          >
            {ACTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </Select>
        </Label>
      )}
      {node.kind === 'work' && section && (
        <div className="inspector-block">
          <div className="inspector-block-head">
            <span>节点内容</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setPrompt(prompt === null ? actions?.body ?? '' : null)}
            >
              {prompt === null ? '编辑' : '收起'}
            </Button>
          </div>
          {prompt === null ? (
            <pre className="inspector-preview">{actions?.body || '（空）'}</pre>
          ) : (
            <Textarea
              className="min-h-24 font-mono text-xs"
              value={prompt}
              aria-label="节点内容"
              onChange={(event) => setPrompt(event.target.value)}
              onBlur={() => onAction(node.ref, { body: prompt })}
            />
          )}
        </div>
      )}
      {!ins.length && node.kind !== 'start' && (
        <div className="inspector-block">
          <div className="inspector-block-head">
            <span>入口</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={!from}
              onClick={() => onGraph(connect(graph, from, node.ref))}
            >
              <CornerDownRight />
              接入
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">这个节点还不在任何路径上，选一个上游节点接入。</p>
          <Select
            className="h-8 text-xs"
            aria-label="上游节点"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          >
            {upstream.map((item) => (
              <option key={item.ref} value={item.ref}>
                {item.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {node.kind !== 'parallel' && (
        <div className="inspector-block">
          <div className="inspector-block-head">
            <span>结果边</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={!canAddOutgoing(graph, node)}
              onClick={() => onGraph(addResult(graph, node.ref))}
            >
              <Plus />
              结果
            </Button>
          </div>
          {fixedOutgoing(node) && (
            <p className="text-xs text-muted-foreground">这类节点只有一条固定出边，改连目标即可。</p>
          )}
          {outs.length ? (
            <ul className="inspector-edges">
              {outs.map((edge) => (
                <li key={edge.id}>
                  {edge.result ? (
                    <Input
                      className="h-8 min-w-0 text-xs"
                      aria-label="结果名"
                      value={edge.result}
                      onChange={(event) => onGraph(renameResult(graph, edge.id, event.target.value))}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">直接流转</span>
                  )}
                  <Select
                    className="h-8 text-xs"
                    aria-label="目标节点"
                    value={edge.to}
                    onChange={(event) => onGraph(retargetEdge(graph, edge.id, event.target.value))}
                  >
                    {graph.nodes
                      .filter((item) => item.ref !== node.ref && item.kind !== 'start')
                      .map((item) => (
                        <option key={item.ref} value={item.ref}>
                          {item.name}
                        </option>
                      ))}
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="删除结果边"
                    onClick={() => onGraph(removeEdge(graph, edge.id))}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">还没有出边。</p>
          )}
        </div>
      )}
      {node.kind === 'start' && (
        <Button variant="primary" className="w-full" onClick={onStart}>
          <Play />
          用这个包启动运行
        </Button>
      )}
      {!terminal && (
        <Button variant="destructive" className="w-full" onClick={() => onGraph(removeNode(graph, node.ref))}>
          <Trash2 />
          删除节点
        </Button>
      )}
    </div>
  )
}

function EdgeInspector({
  graph,
  id,
  onGraph,
}: {
  graph: FlowGraph
  id: string
  onGraph: (next: FlowGraph) => void
}) {
  const edge = graph.edges.find((item) => item.id === id)
  if (!edge) return null
  const source = graph.nodes.find((node) => node.ref === edge.from)
  const result = edge.result
  return (
    <div className="inspector">
      <header>
        <h2>{result ?? '直接流转'}</h2>
        <code>
          {source?.name ?? edge.from} → {graph.nodes.find((node) => node.ref === edge.to)?.name ?? edge.to}
        </code>
      </header>
      {result && (
        <Label className="flex-col items-stretch gap-1.5">
          结果名
          <Input
            className="h-8 text-xs"
            value={result}
            onChange={(event) => onGraph(renameResult(graph, id, event.target.value))}
          />
        </Label>
      )}
      <Label className="flex-col items-stretch gap-1.5">
        目标节点
        <Select
          className="h-8 text-xs"
          value={edge.to}
          onChange={(event) => onGraph(retargetEdge(graph, id, event.target.value))}
        >
          {graph.nodes
            .filter((node) => node.ref !== edge.from && node.kind !== 'start')
            .map((node) => (
              <option key={node.ref} value={node.ref}>
                {node.name}
              </option>
            ))}
        </Select>
      </Label>
      <Button variant="destructive" className="w-full" onClick={() => onGraph(removeEdge(graph, id))}>
        <Trash2 />
        删除这条边
      </Button>
    </div>
  )
}
