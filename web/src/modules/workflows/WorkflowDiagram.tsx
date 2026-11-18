import { useId, useMemo, useState } from 'react'

import type { Role, Workflow } from '@/shared/api/types'
import { Icon } from '@/shared/ui/icon'
import { nodeTypeLabel } from './definition'
import './workflows.css'

export interface WorkflowDiagramProps {
  workflow: Workflow
  roles?: Role[]
}

interface DiagramLayout {
  positions: Map<string, { x: number; y: number }>
  width: number
  height: number
}

/** 按依赖分列布局：先放没有未放置上游的节点，循环依赖时退回剩余节点。 */
function computeLayout(workflow: Workflow): DiagramLayout {
  const remaining = new Set(workflow.nodes.map((node) => node.id))
  const positions = new Map<string, { x: number; y: number }>()
  let column = 0
  let maxRows = 1
  while (remaining.size) {
    let ready = [...remaining].filter((id) => !workflow.edges.some((edge) => edge.target === id && remaining.has(edge.source)))
    if (!ready.length) ready = [...remaining]
    maxRows = Math.max(maxRows, ready.length)
    ready.forEach((id, row) => {
      positions.set(id, { x: column * 240 + 24, y: row * 106 + 24 })
      remaining.delete(id)
    })
    column++
  }
  return { positions, width: Math.max(column * 240 + 8, 280), height: maxRows * 106 + 20 }
}

/** 只读工作流依赖图：固定分层布局，点击节点查看配置。 */
export default function WorkflowDiagram({ workflow, roles = [] }: WorkflowDiagramProps) {
  const [selectedId, setSelectedId] = useState('')
  const markerId = `flow-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const layout = useMemo(() => computeLayout(workflow), [workflow])
  const selected = workflow.nodes.find((node) => node.id === selectedId)
  const lines = useMemo(() => workflow.edges.flatMap((edge) => {
    const from = layout.positions.get(edge.source)
    const to = layout.positions.get(edge.target)
    if (!from || !to) return []
    const x = from.x + 190
    const y = from.y + 35
    return [{ key: `${edge.source}-${edge.target}`, path: `M ${x} ${y} C ${x + 28} ${y}, ${to.x - 28} ${to.y + 35}, ${to.x - 4} ${to.y + 35}` }]
  }), [workflow, layout])

  return (
    <>
      <div className="diagram-scroll" aria-label="只读工作流依赖图">
        <div className="diagram" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
          <svg width={layout.width} height={layout.height} aria-hidden="true" className="connections">
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6} markerHeight={6} orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {lines.map((line) => (
              <path key={line.key} d={line.path} fill="none" stroke="currentColor" strokeWidth={1.5} markerEnd={`url(#${markerId})`} />
            ))}
          </svg>
          {workflow.nodes.map((node) => {
            const active = selectedId === node.id
            const position = layout.positions.get(node.id)
            return (
              <button
                key={node.id}
                type="button"
                className={active ? 'flow-node selected' : 'flow-node'}
                style={{ left: `${position?.x}px`, top: `${position?.y}px` }}
                aria-pressed={active}
                onClick={() => { setSelectedId(active ? '' : node.id) }}
              >
                <Icon name={node.type === 'agent' ? 'robot' : node.type === 'approval' ? 'gate' : 'terminal'} size={18} />
                <span><strong>{node.name}</strong><small>{nodeTypeLabel[node.type]}</small></span>
              </button>
            )
          })}
        </div>
      </div>
      {selected ? (
        <div className="node-info">
          <div className="flex items-center gap-2">
            <strong>{selected.name}</strong>
            <code className="text-xs text-txt3">{selected.id}</code>
          </div>
          <p className="mt-1 text-sm text-txt3">
            类型：{nodeTypeLabel[selected.type]}
            {selected.roleId ? <> · 角色：{roles.find((role) => role.id === selected.roleId)?.name || selected.roleId}</> : null}
          </p>
          {selected.script ? <pre className="mt-3 whitespace-pre-wrap text-xs">{selected.script}</pre> : null}
          <p className="mt-2 text-xs text-txt3">
            上游：{workflow.edges
              .filter((edge) => edge.target === selected.id)
              .map((edge) => workflow.nodes.find((node) => node.id === edge.source)?.name || edge.source)
              .join('、') || '起始节点'}
          </p>
        </div>
      ) : (
        <p className="px-4 py-3 text-xs text-txt3">点击节点查看类型、角色与依赖配置。流程图为只读视图。</p>
      )}
    </>
  )
}
