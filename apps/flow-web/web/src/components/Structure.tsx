import { useMemo, useState } from 'react'
import type { FlowDetail } from '../api'
import { layoutFlow } from '../lib/graph'
import { nodeKindLabel, outcomeLabel } from '../lib/flow'
import { FlowGraph } from './FlowGraph'

/**
 * 结构区：默认画成图，也可以切回逐条列表看提示词与请求。
 * 两种视图共用同一份解析结果，不额外请求。
 */
export function Structure({
  detail,
  currentRef,
}: {
  detail: FlowDetail
  /** 运行最后进入的节点，标在图上。 */
  currentRef?: string
}) {
  const [mode, setMode] = useState<'graph' | 'list'>('graph')
  const [selectedRef, setSelectedRef] = useState<string>()
  const layout = useMemo(() => layoutFlow(detail), [detail])
  const selected = detail.nodes.find((node) => node.ref === selectedRef)

  return (
    <section className="flow-structure">
      <div className="flow-section-head">
        <span>结构</span>
        <span className="flow-structure-actions">
          <span className="flow-count">
            {detail.nodeCount} 节点 · {detail.parallels.length} 并行
          </span>
          <button
            type="button"
            className={`flow-tab${mode === 'graph' ? ' is-active' : ''}`}
            aria-pressed={mode === 'graph'}
            onClick={() => setMode('graph')}
          >
            图
          </button>
          <button
            type="button"
            className={`flow-tab${mode === 'list' ? ' is-active' : ''}`}
            aria-pressed={mode === 'list'}
            onClick={() => setMode('list')}
          >
            列表
          </button>
        </span>
      </div>

      {mode === 'graph' ? (
        <>
          <FlowGraph
            layout={layout}
            {...(currentRef === undefined ? {} : { currentRef })}
            {...(selectedRef === undefined ? {} : { selectedRef })}
            onSelect={(ref) =>
              setSelectedRef((current) => (current === ref ? undefined : ref))
            }
          />
          <p className="flow-graph-hint">
            点节点看提示词或命令，并高亮它的出边；再点一次取消。虚线是回到前面节点的结果边。
          </p>
          {selected === undefined ? null : (
            <div className="flow-node is-floating">
              <NodeBody node={selected} />
            </div>
          )}
        </>
      ) : (
        <ol className="flow-nodes">
          {detail.nodes.map((node, index) => (
            <li key={node.ref} className="flow-node">
              <div className="flow-node-head">
                <span className="flow-node-index">{index + 1}</span>
                <span className="flow-node-name">{node.name}</span>
                <span className={`flow-chip kind-${node.kind}`}>
                  {nodeKindLabel(node.kind)}
                </span>
              </div>
              <NodeBody node={node} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function NodeBody({ node }: { node: FlowDetail['nodes'][number] }) {
  return (
    <div className="flow-node-body">
      {node.kind === 'command' ? (
        <code className="flow-command">
          {node.request?.command ?? ''} {(node.request?.args ?? []).join(' ')}
          {node.request?.output === 'variables' ? ' → 变量' : ''}
        </code>
      ) : (
        <p className="flow-prompt">{node.prompt}</p>
      )}
      <ul className="flow-outcomes">
        {node.outcomes.map((outcome) => (
          <li key={outcome.name} className="flow-outcome" title={outcome.description}>
            {outcomeLabel(outcome)}
          </li>
        ))}
      </ul>
    </div>
  )
}
