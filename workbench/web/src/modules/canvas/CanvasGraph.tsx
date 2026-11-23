import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow,
  applyNodeChanges, useInternalNode, useNodesInitialized, useReactFlow, useStore,
  type Connection, type Edge, type Node, type NodeChange, type NodeProps, type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button } from '@/shared/ui/button'
import './canvas-graph.css'

export interface Point { x: number; y: number }

export interface CanvasNode {
  id: string
  label: string
  position: Point
  content?: ReactNode
}

export interface CanvasEdge { id: string; from: string; to: string }

export interface CanvasGraphProps {
  nodes: readonly CanvasNode[]
  edges: readonly CanvasEdge[]
  focusNodeId?: string
  editableEdges?: boolean
  showMiniMap?: boolean
  onMove: (id: string, position: Point) => void
  onSelectNode?: (id: string) => void
  onOpenNode?: (id: string) => void
  onSelectEdge?: (id: string) => void
  onConnect?: (from: string, to: string) => void
  onReconnect?: (id: string, from: string, to: string) => void
}

type CardNode = Node<{ label: string; content?: ReactNode }, 'card'>
type Selection = { nodeId?: string; edgeId?: string }

const minZoom = 0.2
const maxZoom = 2
const fitOptions = { padding: 0.16, maxZoom: 1 }
const defaultEdgeOptions = {
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed, color: 'rgb(var(--c-txt3))' },
}

function NodeCard({ data, isConnectable }: NodeProps<CardNode>) {
  const canStartConnection = useStore((state) => Boolean(state.onConnect))
  return (
    <div className="wb-canvas-card">
      <Handle type="target" position={Position.Left} isConnectable={isConnectable}
        isConnectableStart={isConnectable && canStartConnection} />
      <div className="wb-canvas-card-title">{data.label}</div>
      {data.content != null && (
        <div
          className="wb-canvas-card-content nodrag nopan nowheel nokey"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {data.content}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={isConnectable}
        isConnectableStart={isConnectable && canStartConnection} />
    </div>
  )
}

const nodeTypes = { card: NodeCard } satisfies NodeTypes

function projectNodes(input: readonly CanvasNode[], previous: CardNode[] = []): CardNode[] {
  const byId = new Map(previous.map((node) => [node.id, node]))
  return input.map(({ id, label, position, content }) => {
    const old = byId.get(id)
    return {
      id,
      type: 'card',
      position: old?.dragging ? old.position : position,
      data: { label, content },
      ariaLabel: label,
      measured: old?.measured,
      selected: old?.selected,
      dragging: old?.dragging,
    }
  })
}

function CanvasFocus({ nodeId }: { nodeId: string }) {
  const { getInternalNode, getZoom, setCenter, viewportInitialized } = useReactFlow<CardNode>()
  const node = useInternalNode<CardNode>(nodeId)
  const layoutReady = useNodesInitialized()
  const centered = useRef(false)
  useEffect(() => {
    if (centered.current || !viewportInitialized || !layoutReady || !node) return
    // Give ResizeObserver a frame to report content size changes from the focus commit.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const target = getInternalNode(nodeId)
        const width = target?.measured.width
        const height = target?.measured.height
        if (!target || width === undefined || height === undefined) return
        const { x, y } = target.internals.positionAbsolute
        centered.current = true
        void setCenter(x + width / 2, y + height / 2, { zoom: getZoom() })
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [getInternalNode, getZoom, layoutReady, node, nodeId, setCenter, viewportInitialized])
  return null
}

function CanvasControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const zoom = useStore((state) => state.transform[2])
  const hasNodes = useStore((state) => state.nodes.length > 0)
  return (
    <Panel position="bottom-left" className="wb-canvas-controls" role="group" aria-label="画布视图">
      <Button size="icon" variant="ghost" icon="plus" title="放大" aria-label="放大" disabled={zoom >= maxZoom}
        onClick={() => void zoomIn()} />
      <Button size="icon" variant="ghost" icon="zoom-out" title="缩小" aria-label="缩小" disabled={zoom <= minZoom}
        onClick={() => void zoomOut()} />
      <Button size="icon" variant="ghost" icon="expand" title="适应视图" aria-label="适应视图" disabled={!hasNodes}
        onClick={() => void fitView(fitOptions)} />
    </Panel>
  )
}

export function CanvasGraph({
  nodes, edges, focusNodeId, editableEdges = false, showMiniMap = false,
  onMove, onSelectNode, onOpenNode, onSelectEdge, onConnect, onReconnect,
}: CanvasGraphProps) {
  const graphId = useId()
  const [nodeState, setNodeState] = useState(() => ({ input: nodes, view: projectNodes(nodes) }))
  if (nodeState.input !== nodes) {
    setNodeState({ input: nodes, view: projectNodes(nodes, nodeState.view) })
  }
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>()
  const selection = useRef<Selection>({})
  const flowEdges = useMemo<Edge[]>(() => edges.flatMap(({ id, from, to }) => {
    const source = nodesById.get(from)
    const target = nodesById.get(to)
    return source && target ? [{
      id, source: from, target: to, selected: id === selectedEdgeId,
      ariaLabel: `${source.label} → ${target.label}`,
    }] : []
  }), [edges, nodesById, selectedEdgeId])

  const changeNodes = useCallback((changes: NodeChange<CardNode>[]) => {
    setNodeState((state) => ({
      ...state,
      view: applyNodeChanges(changes.flatMap<NodeChange<CardNode>>((change) => {
        if (change.type === 'dimensions' || change.type === 'select') return [change]
        if (change.type !== 'position' || !nodesById.has(change.id)) return []
        // End the visual override on drop. Caller coordinates then take effect, including rollback.
        return [change.dragging ? change : { ...change, position: nodesById.get(change.id)?.position }]
      }), state.view),
    }))
  }, [nodesById])

  const selectionChanged = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams<CardNode, Edge>) => {
    const nodeId = selectedNodes[0]?.id
    const edgeId = selectedEdges[0]?.id
    const last = selection.current
    selection.current = { nodeId, edgeId }
    if (nodeId !== undefined && nodeId !== last.nodeId) onSelectNode?.(nodeId)
    if (edgeId !== undefined && edgeId !== last.edgeId) onSelectEdge?.(edgeId)
  }, [onSelectEdge, onSelectNode])

  const canEditEdges = editableEdges && Boolean(onConnect || onReconnect)
  const validEndpoints = ({ source, target }: Connection) => nodesById.has(source) && nodesById.has(target)

  return (
    <div className="wb-canvas">
      <ReactFlow<CardNode, Edge>
        id={graphId}
        aria-label="图形画布"
        nodes={nodeState.view}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        minZoom={minZoom}
        maxZoom={maxZoom}
        fitView
        fitViewOptions={fitOptions}
        attributionPosition="top-right"
        zoomOnDoubleClick={false}
        preventScrolling={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        selectNodesOnDrag={false}
        nodesConnectable={canEditEdges}
        connectOnClick={canEditEdges && Boolean(onConnect)}
        edgesReconnectable={canEditEdges && Boolean(onReconnect)}
        onNodesChange={changeNodes}
        onEdgesChange={(changes) => {
          setSelectedEdgeId((id) => {
            for (const change of changes) {
              if (change.type !== 'select') continue
              if (change.selected) id = change.id
              else if (id === change.id) id = undefined
            }
            return id
          })
        }}
        onSelectionChange={selectionChanged}
        onNodeClick={(_, node) => {
          if (node.id === selection.current.nodeId) onSelectNode?.(node.id)
        }}
        onEdgeClick={(_, edge) => {
          if (edge.id === selection.current.edgeId) onSelectEdge?.(edge.id)
        }}
        onNodeDoubleClick={(_, node) => onOpenNode?.(node.id)}
        onNodeDragStop={(_, node) => {
          const original = nodesById.get(node.id)?.position
          if (original && (original.x !== node.position.x || original.y !== node.position.y)) {
            onMove(node.id, node.position)
          }
        }}
        onConnect={editableEdges && onConnect ? (connection) => {
          if (validEndpoints(connection)) onConnect(connection.source, connection.target)
        } : undefined}
        onReconnect={editableEdges && onReconnect ? (edge, connection) => {
          if (validEndpoints(connection) && (edge.source !== connection.source || edge.target !== connection.target)) {
            onReconnect(edge.id, connection.source, connection.target)
          }
        } : undefined}
      >
        <Background gap={20} size={1.25} color="rgb(var(--c-txt3) / 0.25)" />
        <CanvasControls />
        {showMiniMap && <MiniMap ariaLabel="画布缩略图" pannable zoomable />}
        {focusNodeId !== undefined && nodesById.has(focusNodeId) && (
          <CanvasFocus key={focusNodeId} nodeId={focusNodeId} />
        )}
      </ReactFlow>
    </div>
  )
}
