import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow,
  applyNodeChanges, useInternalNode, useNodesInitialized, useReactFlow, useStore, useStoreApi,
  type Connection, type Edge, type Node, type NodeChange, type NodeProps, type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { menuAnchor, type MenuAnchor } from '@/shared/ui/menu-anchor'
import './canvas-graph.css'

export interface Point { x: number; y: number }

export interface CanvasNode {
  id: string
  label: string
  icon?: string
  position: Point
  content?: ReactNode
}

export interface CanvasEdge { id: string; from: string; to: string }
export type CanvasSelection = { kind: 'node' | 'edge'; id: string }
export type CanvasContextTarget = { kind: 'pane' } | CanvasSelection

export interface CanvasGraphProps {
  nodes: readonly CanvasNode[]
  edges: readonly CanvasEdge[]
  focusNodeId?: string
  focusKey?: string
  revealNodeId?: string
  selection: CanvasSelection | null
  editableEdges?: boolean
  showMiniMap?: boolean
  onMove: (id: string, position: Point) => void
  onSelection?: (selection: CanvasSelection | null) => void
  onOpenNode?: (id: string) => void
  onContext?: (target: CanvasContextTarget, anchor: MenuAnchor) => void
  onConnect?: (from: string, to: string) => void
  onReconnect?: (id: string, from: string, to: string) => void
}

type CardNode = Node<{ label: string; icon?: string; content?: ReactNode }, 'card'>

const minZoom = 0.2
const maxZoom = 2
const fitOptions = { padding: 0.16, maxZoom: 1 }
const defaultViewport = { x: 40, y: 48, zoom: 1 }
const defaultEdgeOptions = { type: 'smoothstep' }
const edgeMarker = { type: MarkerType.ArrowClosed, color: 'rgb(var(--c-txt3))' }
const highlightedMarker = { ...edgeMarker, color: 'rgb(var(--c-accent-2))' }

function NodeCard({ data, isConnectable }: NodeProps<CardNode>) {
  const canStartConnection = useStore((state) => Boolean(state.onConnect))
  return (
    <div className="wb-canvas-card">
      <Handle type="target" position={Position.Left} isConnectable={isConnectable}
        isConnectableStart={isConnectable && canStartConnection} />
      <div className="wb-canvas-card-title">
        {data.icon && <Icon name={data.icon} size={14} />}
        <span title={data.label}>{data.label}</span>
      </div>
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
  return input.map(({ id, label, icon, position, content }) => {
    const old = byId.get(id)
    return {
      id,
      type: 'card',
      position: old?.dragging ? old.position : position,
      data: { label, icon, content },
      ariaLabel: label,
      measured: old?.measured,
      dragging: old?.dragging,
    }
  })
}

function CanvasFocus({ nodeId, onlyIfOutside }: { nodeId: string; onlyIfOutside: boolean }) {
  const { getInternalNode, getViewport, setCenter, viewportInitialized } = useReactFlow<CardNode>()
  const store = useStoreApi()
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
        const { x: offsetX, y: offsetY, zoom } = getViewport()
        const centerX = x + width / 2
        const centerY = y + height / 2
        const screenX = centerX * zoom + offsetX
        const screenY = centerY * zoom + offsetY
        const { width: viewWidth, height: viewHeight } = store.getState()
        centered.current = true
        if (onlyIfOutside && screenX >= 0 && screenX <= viewWidth && screenY >= 0 && screenY <= viewHeight) return
        void setCenter(centerX, centerY, { zoom })
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [getInternalNode, getViewport, layoutReady, node, nodeId, onlyIfOutside, setCenter, store, viewportInitialized])
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
      <span className="wb-canvas-zoom" aria-label={`缩放 ${Math.round(zoom * 100)}%`}>{Math.round(zoom * 100)}%</span>
    </Panel>
  )
}

export function CanvasGraph({
  nodes, edges, focusNodeId, focusKey, revealNodeId, selection, editableEdges = false, showMiniMap = false,
  onMove, onSelection, onOpenNode, onContext, onConnect, onReconnect,
}: CanvasGraphProps) {
  const graphId = useId()
  const surface = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<CanvasSelection | null>(null)
  const [keyboardFocus, setKeyboardFocus] = useState<CanvasSelection | null>(null)
  const [initialFit] = useState(() => nodes.length > 0)
  const [nodeState, setNodeState] = useState(() => ({ input: nodes, view: projectNodes(nodes) }))
  if (nodeState.input !== nodes) {
    setNodeState({ input: nodes, view: projectNodes(nodes, nodeState.view) })
  }
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const selectedNodeId = selection?.kind === 'node' ? selection.id : undefined
  const selectedEdgeId = selection?.kind === 'edge' ? selection.id : undefined
  const flowNodes = useMemo(() => nodeState.view.map(node => ({ ...node, selected: node.id === selectedNodeId })), [nodeState.view, selectedNodeId])
  const focus = selectedEdgeId ? selection : hover ?? keyboardFocus ?? selection
  const flowEdges = useMemo<Edge[]>(() => {
    const visibleEdges = edges.filter(edge => nodesById.has(edge.from) && nodesById.has(edge.to))
    const isRelated = (edge: CanvasEdge) => focus?.kind === 'node' ? edge.from === focus.id || edge.to === focus.id : edge.id === focus?.id
    const hasRelated = visibleEdges.some(isRelated)
    return visibleEdges.map(edge => {
      const { id, from, to } = edge
      const related = isRelated(edge)
      return {
        id, source: from, target: to, selected: id === selectedEdgeId,
        className: related ? 'wb-edge-emphasized' : hasRelated ? 'wb-edge-muted' : undefined,
        markerEnd: related ? highlightedMarker : edgeMarker,
        ariaLabel: `${nodesById.get(from)!.label} → ${nodesById.get(to)!.label}`,
      }
    })
  }, [edges, focus, nodesById, selectedEdgeId])

  const changeNodes = useCallback((changes: NodeChange<CardNode>[]) => {
    const geometry = changes.flatMap<NodeChange<CardNode>>((change) => {
      if (change.type === 'dimensions') return [change]
      if (change.type !== 'position' || !nodesById.has(change.id)) return []
      // End the visual override on drop. Caller coordinates take effect, including rollback.
      return [change.dragging ? change : { ...change, position: nodesById.get(change.id)?.position }]
    })
    if (geometry.length) setNodeState(state => ({ ...state, view: applyNodeChanges(geometry, state.view) }))
  }, [nodesById])

  function selectOnKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target
    if (!(target instanceof Element)) return
    if (event.key === 'Escape' && (target === event.currentTarget || target.matches('.react-flow__node, .react-flow__edge'))) {
      onSelection?.(null)
    } else if (event.key === 'Enter' || event.key === ' ') {
      const id = target.getAttribute('data-id')
      if (!id) return
      if (target.matches('.react-flow__node')) onSelection?.({ kind: 'node', id })
      if (target.matches('.react-flow__edge')) onSelection?.({ kind: 'edge', id })
    }
  }

  const canEditEdges = editableEdges && Boolean(onConnect || onReconnect)
  const validEndpoints = ({ source, target }: Connection) => nodesById.has(source) && nodesById.has(target)

  return (
    <div className="wb-canvas" ref={surface} tabIndex={onContext ? 0 : undefined} role="group" aria-label="画布操作" onKeyDown={selectOnKey}
      onMouseLeave={() => setHover(null)}
      onFocus={event => {
        const target = event.target
        const id = target.getAttribute('data-id')
        if (id && target.matches(':focus-visible')) {
          if (target.matches('.react-flow__node')) setKeyboardFocus({ kind: 'node', id })
          if (target.matches('.react-flow__edge')) setKeyboardFocus({ kind: 'edge', id })
        }
      }}
      onBlur={() => setKeyboardFocus(null)}
      onContextMenu={onContext ? event => {
        if (event.target === event.currentTarget) onContext({ kind: 'pane' }, menuAnchor(event, surface.current))
      } : undefined}>
      <ReactFlow<CardNode, Edge>
        id={graphId}
        aria-label="图形画布"
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        minZoom={minZoom}
        maxZoom={maxZoom}
        defaultViewport={initialFit ? undefined : defaultViewport}
        fitView={initialFit}
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
        onPaneClick={() => onSelection?.(null)}
        onNodeClick={(_, node) => onSelection?.({ kind: 'node', id: node.id })}
        onEdgeClick={(_, edge) => onSelection?.({ kind: 'edge', id: edge.id })}
        onNodeMouseEnter={(_, node) => setHover({ kind: 'node', id: node.id })}
        onNodeMouseLeave={() => setHover(null)}
        onEdgeMouseEnter={(_, edge) => setHover({ kind: 'edge', id: edge.id })}
        onEdgeMouseLeave={() => setHover(null)}
        onPaneContextMenu={onContext ? event => {
          if (event.target === event.currentTarget) onContext({ kind: 'pane' }, menuAnchor(event, surface.current))
        } : undefined}
        onNodeContextMenu={onContext ? (event, node) => onContext({ kind: 'node', id: node.id }, menuAnchor(event, surface.current)) : undefined}
        onEdgeContextMenu={onContext ? (event, edge) => onContext({ kind: 'edge', id: edge.id }, menuAnchor(event, surface.current)) : undefined}
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
        <Background gap={24} size={1.35} color="rgb(var(--c-txt3) / 0.28)" />
        <CanvasControls />
        {showMiniMap && <MiniMap ariaLabel="画布缩略图" pannable zoomable />}
        {focusNodeId !== undefined && nodesById.has(focusNodeId) && (
          <CanvasFocus key={JSON.stringify([focusNodeId, focusKey])} nodeId={focusNodeId} onlyIfOutside={false} />
        )}
        {revealNodeId !== undefined && nodesById.has(revealNodeId) && (
          <CanvasFocus key={revealNodeId} nodeId={revealNodeId} onlyIfOutside />
        )}
      </ReactFlow>
    </div>
  )
}
