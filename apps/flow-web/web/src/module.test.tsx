import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspaceProvider, useWorkspace } from '@ursi/workspace-shell'
import type { Selection } from '@ursi/workspace-shell'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FlowClient, FlowDetail, FlowSummary, RunView } from './api'
import { FLOW_KIND, PACKAGE_KIND } from './lib/actions'
import { createFlowModuleWithClient } from './module'
import { useFlowStore } from './store'

/**
 * 模块把当前选中发布到外壳：只选中了 Flow 包时发 `flow.package`（这样「在文件模块打开 Flow 目录」
 * 不必先跑一次），打开了运行发 `flow.run`，两者都没有时不清别的模块的选中。
 */

const detail: FlowDetail = {
  id: 'code-change',
  dir: '/home/me/.ursi/flow/code-change',
  path: '/home/me/.ursi/flow/code-change/FLOW.md',
  startNodeRef: 'change',
  name: '代码修改',
  description: '',
  nodeCount: 1,
  variableCount: 0,
  valid: true,
  variables: [],
  nodes: [
    {
      ref: 'change',
      name: '完成修改',
      kind: 'agent',
      prompt: '改代码',
      outcomes: [{ name: '已修改', description: '', destination: { kind: 'finish' } }],
    },
  ],
  parallels: [],
}

const run: RunView = {
  runId: 'run-1',
  flowId: 'code-change',
  executor: 'fake',
  status: 'completed',
  startedAt: '2024-03-04T05:06:07.000Z',
  updatedAt: '2024-03-04T05:06:08.000Z',
  stepCount: 1,
  variables: {},
  steps: [],
  events: [],
  active: false,
}

const config = {
  flowHome: 'file:///home/me/.ursi/flow',
  stateDir: '/s',
  runsRoot: '/s/runs',
  executors: [{ id: 'fake', title: 'Fake', description: '' }],
  defaultExecutor: 'fake',
}

function clientOf(flows: FlowSummary[]): FlowClient {
  return {
    getConfig: async () => config,
    setFlowHome: async (flowHome) => ({ ...config, flowHome, executors: [], defaultExecutor: '' }),
    listFlows: async () => ({ flowHome: config.flowHome, flows }),
    getFlow: async (id) => ({ ...detail, id }),
    listRuns: async () => [],
    startRun: async () => ({ runId: 'run-1' }),
    getRun: async () => run,
    confirm: async () => run,
    resume: async () => run,
    stopRun: async () => run,
  }
}

/** 把外壳里那一份选中写进 DOM，供测试在 act 之外断言。 */
function Mirror() {
  const { selection } = useWorkspace()
  return <output data-selection={JSON.stringify(selection)} />
}

/** 把 store 的写操作递到组件外，测试借此打开一次运行。 */
const handles: { selectRun?: (id: string | null) => Promise<void> } = {}
function Driver() {
  handles.selectRun = useFlowStore((state) => state.selectRun)
  return null
}

describe('选中发布', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function mount(flows: FlowSummary[]): Promise<void> {
    const module = createFlowModuleWithClient(clientOf(flows))
    const Provider = module.Provider!
    await act(async () => {
      root.render(
        <WorkspaceProvider>
          <Provider>
            <Driver />
            <Mirror />
          </Provider>
        </WorkspaceProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  const selectionOf = (): Selection | null =>
    JSON.parse(container.querySelector('output')!.dataset.selection ?? 'null')

  it('只选中了 Flow 包时发布 flow.package，不要求先启动运行', async () => {
    await mount([detail])
    expect(selectionOf()).toEqual({ kind: PACKAGE_KIND, id: 'code-change', label: '代码修改' })
  })

  it('没有可选的 Flow 包时不发布选中', async () => {
    await mount([])
    expect(selectionOf()).toBeNull()
  })

  it('打开运行后改发 flow.run，摘要带 Flow 名与状态', async () => {
    await mount([detail])
    await act(async () => {
      await handles.selectRun!('run-1')
    })
    expect(selectionOf()).toEqual({ kind: FLOW_KIND, id: 'run-1', label: '代码修改 · 已完成' })
  })
})
