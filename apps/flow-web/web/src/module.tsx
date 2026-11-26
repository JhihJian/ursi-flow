import { useEffect, useRef, type ReactNode } from 'react'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { useWorkspace } from '@ursi/workspace-shell'
import { createFlowClient, type FlowClient } from './api'
import { FlowSidebar } from './components/FlowSidebar'
import { FlowWorkspace } from './components/FlowWorkspace'
import { statusLabel } from './lib/flow'
import {
  FLOW_KIND,
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

/** 把所选运行发布到外壳；只清自己发布的选中。 */
function SelectionBridge() {
  const { selection, select } = useWorkspace()
  const run = useFlowStore((state) => state.run)
  const flows = useFlowStore((state) => state.flows)
  const current = useRef(selection)
  current.current = selection

  const next = selectionFor(run, flows)

  useEffect(() => {
    if (next !== null) select(next)
    else if (current.current?.kind === FLOW_KIND) select(null)
  }, [next, select])

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
  return {
    id: 'flow',
    title: 'Flow',
    Provider: ({ children }: { children: ReactNode }) => (
      <FlowProvider client={client}>
        <SnapshotBridge />
        <SelectionBridge />
        {children}
      </FlowProvider>
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
