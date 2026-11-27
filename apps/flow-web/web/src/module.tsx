import { useEffect, useMemo, type ReactNode } from 'react'
import type { Selection, WorkspaceModule } from '@ursi/workspace-shell'
import { useWorkspace } from '@ursi/workspace-shell'
import { createFlowClient, type FlowClient } from './api'
import { FlowSidebar } from './components/FlowSidebar'
import { FlowWorkspace } from './components/FlowWorkspace'
import { FlowHostContext, type FlowHost } from './host'
import { statusLabel } from './lib/flow'
import {
  FLOW_KIND,
  FLOW_SELECTION_KINDS,
  createActions,
  selectionFor,
  type ActionSnapshot,
  type FlowModuleOptions,
} from './lib/actions'
import { FlowProvider, useFlowStore } from './store'

export type { FlowModuleOptions } from './lib/actions'
export { buildRunMarkdown, createActions, selectionFor } from './lib/actions'

/** flow 模块对外暴露的接入代码：宿主只负责登记，不实现模块逻辑。 */

/**
 * 操作在 React 之外执行，需要读到当时的运行与目录。
 * 这份快照由模块根组件在渲染时写入，只存普通值与当前 store 的写操作。
 */
const latest: ActionSnapshot = {}

function SnapshotBridge() {
  const run = useFlowStore((state) => state.run)
  const detail = useFlowStore((state) => state.detail)
  const stop = useFlowStore((state) => state.stop)
  latest.run = run
  latest.flowDir = detail?.dir
  latest.flowName = detail?.name
  latest.stop = stop
  return null
}

/** 选中是否同一份：类型、标识与摘要都相同。 */
function sameSelection(left: Selection | null, right: Selection | null): boolean {
  if (left === null || right === null) return left === right
  return left.kind === right.kind && left.id === right.id && left.label === right.label
}

/**
 * 把当前选中发布到外壳：打开了运行发 `flow.run`，只选中了包发 `flow.package`。
 * 只清自己发布的两种选中，不抹别的模块的。
 *
 * 只有选中真的变了才调 `select`：`select` 会重渲染外壳，外壳重渲染又会跑到这里，
 * 每次都发一个新对象就成死循环。
 */
function SelectionBridge() {
  const { selection, select } = useWorkspace()
  const run = useFlowStore((state) => state.run)
  const flows = useFlowStore((state) => state.flows)
  const flowId = useFlowStore((state) => state.flowId)

  const next = useMemo(() => selectionFor(run, flows, flowId), [run, flows, flowId])

  useEffect(() => {
    if (next !== null) {
      if (!sameSelection(selection, next)) select(next)
    } else if (selection !== null && FLOW_SELECTION_KINDS.includes(selection.kind)) {
      select(null)
    }
  }, [next, selection, select])

  return null
}

/** 状态栏：Flow 包数量、运行中数量与当前运行状态。 */
function FlowStatus() {
  const flows = useFlowStore((state) => state.flows)
  const runs = useFlowStore((state) => state.runs)
  const run = useFlowStore((state) => state.run)
  const running = runs.filter((item) => item.status === 'running').length
  return (
    <span>
      Flow {flows.length} · 运行中 {running}
      {run === undefined ? '' : ` · ${statusLabel(run.status)}`}
    </span>
  )
}

function flowModule(client: FlowClient, options: FlowModuleOptions): WorkspaceModule {
  // host 在工厂里固定引用：组合根每次渲染传新对象也不会让读它的组件重渲染。
  const host: FlowHost = options.host ?? {}
  return {
    id: 'flow',
    title: 'Flow',
    Provider: ({ children }: { children: ReactNode }) => (
      <FlowHostContext.Provider value={host}>
        <FlowProvider client={client}>
          <SnapshotBridge />
          <SelectionBridge />
          {children}
        </FlowProvider>
      </FlowHostContext.Provider>
    ),
    Sidebar: FlowSidebar,
    Workspace: FlowWorkspace,
    context: {
      kind: FLOW_KIND,
      summary: (selection) => selection.label ?? `Run ${selection.id}`,
      Status: FlowStatus,
    },
    actions: createActions(options, () => latest),
  }
}

/**
 * 工厂：模块级只调一次。测试与独立入口可以直接传一个假 client。
 */
export function createFlowModule(
  options: FlowModuleOptions = { apiBaseUrl: '/api/flow-web' },
): WorkspaceModule {
  return flowModule(createFlowClient(options.apiBaseUrl), options)
}

/** 用一个已建好的 client 建模块（独立入口与测试复用同一套组件）。 */
export function createFlowModuleWithClient(
  client: FlowClient,
  options: Omit<FlowModuleOptions, 'apiBaseUrl'> = {},
): WorkspaceModule {
  return flowModule(client, { apiBaseUrl: '', ...options })
}
