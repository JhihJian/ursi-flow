// 图形视图：FLOW.md 的节点卡片、结果边与检查器。参照工作台与 grasp 的画布样式。
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
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
} from 'lucide-react'
import { ACTION_KINDS, type ActionKind, type FlowGraph, type GraphNode, incoming } from './flow/graph'
import { layoutGraph } from './flow/layout'
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

function WorkNode({ data, selected }: NodeProps) {
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
}

function TerminalNode({ data, selected }: NodeProps) {
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
}

function ParallelNode({ data, selected }: NodeProps) {
  const { node, onSelect } = data as unknown as { node: GraphNode; onSelect: () => void }
  return (
    <div className={'cparallel' + (selected ? ' is-selected' : '')} onClick={onSelect}>
      <Handle type="target" position={Position.Left} className="cport cport--in" />
      <GitBranch size={14} />
      {node.name}
      <Handle type="source" position={Position.Right} id="out" className="cport" />
    </div>
  )
}

function ResultEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  })
  const data = props.data as unknown as { result?: string; selected?: boolean }
  const tone = data?.result ? toneOf(data.result) : 'default'
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
      {data?.result && (
        <EdgeLabelRenderer>
          <div
            className={`cedge-label tone-${tone} nodrag nopan`}
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}
          >
            {data.result}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { work: WorkNode, start: TerminalNode, finish: TerminalNode, parallel: ParallelNode }
const edgeTypes = { result: ResultEdge }

export function FlowCanvas({ graph, sections, issues, onGraph, onAction, onStart }: CanvasProps) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [selection, setSelection] = useState<Selection | null>(null)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [showMinimap, setShowMinimap] = useState(true)
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

  const sectionOf = useCallback(
    (node: GraphNode) => sections.find((section) => section.name === node.name),
    [sections],
  )
  const layout = useMemo(() => ({ ...layoutGraph(graph), ...positions }), [graph, positions])
  const nodes: Node[] = useMemo(
    () =>
      graph.nodes.map((node) => ({
        id: node.ref,
        type: node.kind,
        position: layout[node.ref] ?? { x: 0, y: 0 },
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
          onSelect: () => setSelection({ kind: 'node', id: node.ref }),
        },
      })),
    [graph, layout, selection, sectionOf],
  )
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        sourceHandle: edge.result ?? 'out',
        type: 'result',
        data: { result: edge.result, selected: selection?.kind === 'edge' && selection.id === edge.id },
      })),
    [graph, selection],
  )

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
      <aside className="canvas-palette" aria-label="添加节点">
        <div className="palette-title">
          <Boxes size={14} />
          添加节点
        </div>
        {ACTION_KINDS.map((kind) => {
          const Icon = kindIcon[kind]
          return (
            <button key={kind} className="palette-item" onClick={() => add('work', kind)}>
              <Icon size={14} />
              {kind}
            </button>
          )
        })}
        <button className="palette-item" onClick={() => add('parallel')}>
          <GitBranch size={14} />
          并行
        </button>
        <div className="palette-foot">
          <button className="cchrome-btn" onClick={() => setPositions({})} title="自动布局">
            <ListTree size={14} />
          </button>
          <button
            className={'cchrome-btn' + (showMinimap ? ' is-on' : '')}
            onClick={() => setShowMinimap(!showMinimap)}
            title="缩略图"
            aria-pressed={showMinimap}
          >
            <Layers size={14} />
          </button>
          <span className="palette-count">{graph.nodes.length} 节点</span>
        </div>
        {issues.length > 0 && (
          <ul className="canvas-issues" aria-label="图结构问题">
            {issues.slice(0, 6).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </aside>

      <div className="canvas-area">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          minZoom={0.2}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          onNodesChange={(changes) => {
            const moved = changes.flatMap((change) =>
              change.type === 'position' && change.position
                ? [{ id: change.id, position: change.position }]
                : [],
            )
            if (!moved.length) return
            setPositions((current) => {
              const next = { ...current }
              for (const change of moved) next[change.id] = change.position
              return next
            })
          }}
          onConnect={(connection) => {
            if (!connection.source || !connection.target) return
            onGraph(connect(graph, connection.source, connection.target, connection.sourceHandle))
            setSelection(null)
          }}
          onNodeClick={(_, node) => setSelection({ kind: 'node', id: node.id })}
          onEdgeClick={(_, edge) => setSelection({ kind: 'edge', id: edge.id })}
          onPaneClick={() => setSelection(null)}
        >
          <Background gap={18} size={1} />
          <Controls showInteractive={false} />
          {showMinimap && <MiniMap pannable zoomable />}
        </ReactFlow>
      </div>

      <aside className="canvas-inspector" aria-label="检查器">
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
        ) : selectedEdge ? (
          <EdgeInspector graph={graph} id={selectedEdge.id} onGraph={onGraph} />
        ) : (
          <div className="inspector-empty">
            <p>选择节点或连线查看与修改。</p>
            <p className="muted">从卡片右侧的圆点拖到目标节点即可建立结果边。</p>
          </div>
        )}
      </aside>
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
        <label>
          节点名称
          <input
            className="input"
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
        </label>
      )}
      {node.kind === 'work' && (
        <label>
          动作
          <select
            className="input"
            value={actions?.kind ?? ''}
            onChange={(event) => onAction(node.ref, { kind: event.target.value as ActionKind })}
          >
            {ACTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
      )}
      {node.kind === 'work' && section && (
        <div className="inspector-block">
          <div className="inspector-block-head">
            <span>节点内容</span>
            <button
              className="cchrome-btn"
              onClick={() => setPrompt(prompt === null ? actions?.body ?? '' : null)}
            >
              {prompt === null ? '编辑' : '收起'}
            </button>
          </div>
          {prompt === null ? (
            <pre className="inspector-preview">{actions?.body || '（空）'}</pre>
          ) : (
            <textarea
              className="code short"
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
            <button
              className="cchrome-btn"
              disabled={!from}
              onClick={() => onGraph(connect(graph, from, node.ref))}
            >
              <CornerDownRight size={13} />
              接入
            </button>
          </div>
          <p className="muted">这个节点还不在任何路径上，选一个上游节点接入。</p>
          <select className="input" aria-label="上游节点" value={from} onChange={(event) => setFrom(event.target.value)}>
            {upstream.map((item) => (
              <option key={item.ref} value={item.ref}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {node.kind !== 'parallel' && (
        <div className="inspector-block">
          <div className="inspector-block-head">
            <span>结果边</span>
            <button
              className="cchrome-btn"
              disabled={!canAddOutgoing(graph, node)}
              onClick={() => onGraph(addResult(graph, node.ref))}
            >
              <Plus size={13} />
              结果
            </button>
          </div>
          {fixedOutgoing(node) && <p className="muted">这类节点只有一条固定出边，改连目标即可。</p>}
          {outs.length ? (
            <ul className="inspector-edges">
              {outs.map((edge) => (
                <li key={edge.id}>
                  {edge.result ? (
                    <input
                      className="input"
                      aria-label="结果名"
                      value={edge.result}
                      onChange={(event) => onGraph(renameResult(graph, edge.id, event.target.value))}
                    />
                  ) : (
                    <span className="muted">直接流转</span>
                  )}
                  <select
                    className="input"
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
                  </select>
                  <button
                    className="cchrome-btn"
                    aria-label="删除结果边"
                    onClick={() => onGraph(removeEdge(graph, edge.id))}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">还没有出边。</p>
          )}
        </div>
      )}
      {node.kind === 'start' && (
        <button className="button" onClick={onStart}>
          <Play size={14} />
          用这个包启动运行
        </button>
      )}
      {!terminal && (
        <button className="button danger" onClick={() => onGraph(removeNode(graph, node.ref))}>
          <Trash2 size={14} />
          删除节点
        </button>
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
        <label>
          结果名
          <input
            className="input"
            value={result}
            onChange={(event) => onGraph(renameResult(graph, id, event.target.value))}
          />
        </label>
      )}
      <label>
        目标节点
        <select
          className="input"
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
        </select>
      </label>
      <button className="button danger" onClick={() => onGraph(removeEdge(graph, id))}>
        <Trash2 size={14} />
        删除这条边
      </button>
    </div>
  )
}
