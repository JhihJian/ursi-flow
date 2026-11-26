import { useId } from 'react'
import type { GraphLayout, GraphNodeKind } from '../lib/graph'

const KIND_LABEL: Record<GraphNodeKind, string> = {
  start: '开始',
  finish: '结束',
  parallel: '并行',
  agent: 'Agent',
  confirm: '确认',
  command: '命令',
}

/**
 * Flow 结构图：左到右分层，回边用虚线绕行。
 * 全部用当前页面的灰阶变量绘制，不引入图形库，也不改全局样式。
 */
export function FlowGraph({
  layout,
  currentRef,
  selectedRef,
  onSelect,
}: {
  layout: GraphLayout
  /** 本次运行最后进入的节点，用来标出进度。 */
  currentRef?: string
  selectedRef?: string
  onSelect?: (ref: string) => void
}) {
  const marker = `flow-arrow-${useId()}`
  return (
    <div className="flow-graph">
      <svg
        className="flow-graph-canvas"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label="Flow 结构图"
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="flow-graph-arrow" />
          </marker>
        </defs>
        {layout.edges.map((edge) => (
          <g key={`${edge.from}->${edge.to}:${edge.label ?? ''}`}>
            <path
              d={edge.path}
              className={`flow-graph-edge${edge.back ? ' is-back' : ''}`}
              markerEnd={`url(#${marker})`}
            />
            {edge.label === undefined ? null : (
              <>
                <rect
                  className="flow-graph-label-bg"
                  x={edge.labelX - edge.label.length * 3.2 - 3}
                  y={edge.labelY - 1}
                  width={edge.label.length * 6.4 + 6}
                  height={13}
                />
                <text
                  className="flow-graph-edge-label"
                  x={edge.labelX}
                  y={edge.labelY + 10}
                  textAnchor="middle"
                >
                  {edge.label}
                </text>
              </>
            )}
          </g>
        ))}
        {layout.nodes.map((node) => {
          const current = node.key === currentRef
          const selected = node.key === selectedRef
          return (
            <g
              key={node.key}
              className={`flow-graph-node kind-${node.kind}${current ? ' is-current' : ''}${selected ? ' is-selected' : ''}`}
              tabIndex={0}
              role="button"
              aria-label={`${KIND_LABEL[node.kind]}：${node.label}`}
              onClick={() => onSelect?.(node.key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect?.(node.key)
                }
              }}
            >
              <rect
                className="flow-graph-box"
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
              />
              <text className="flow-graph-kind" x={node.x + 10} y={node.y + 13}>
                {KIND_LABEL[node.kind]}
              </text>
              <text className="flow-graph-name" x={node.x + 10} y={node.y + 27}>
                {node.label}
              </text>
              {current ? (
                <text
                  className="flow-graph-marker"
                  x={node.x + node.width - 8}
                  y={node.y + 13}
                  textAnchor="end"
                >
                  当前
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
