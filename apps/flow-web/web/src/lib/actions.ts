import { parse } from '@ursi/location'
import type { ListDirFn } from '@ursi/directory-picker'
import type {
  Selection,
  ShellHandle,
  WorkspaceAction,
} from '@ursi/workspace-shell'
import type { RunView } from '../api'
import { copyText } from './clipboard'
import { statusLabel, stopDisabledReason } from './flow'

/** flow 模块对外发布的选中类型：打开了某次运行时发布它。 */
export const FLOW_KIND = 'flow.run'
/** 选中了某个 Flow 包、但还没有打开运行时发布它；「在文件模块打开 Flow 目录」对它也适用。 */
export const PACKAGE_KIND = 'flow.package'

/** 本模块发布的全部选中类型；清选中时只清这些。 */
export const FLOW_SELECTION_KINDS: readonly string[] = [FLOW_KIND, PACKAGE_KIND]

export interface FlowModuleOptions {
  /** 同源 API 前缀，由宿主注入。 */
  apiBaseUrl: string
  /**
   * 在文件模块里登记并打开某个目录，入参是位置 URI；组合根注入，模块不 import 文件模块。
   * 返回该目录在文件模块里的标识。
   */
  openRootInFiles?: (root: string) => Promise<{ id: string; label: string }>
  /**
   * 宿主注入的跨模块能力。不注入设备清单：flow home 必须在本机，选目录器只有本机一项。
   */
  host?: {
    /** 浏览本机目录，给 flow home 的选目录器当数据源（组合根接 fs-web 的 `commands.browse`）。 */
    listDir?: ListDirFn
  }
}

export interface ActionSnapshot {
  run?: RunView
  flowDir?: string
  flowName?: string
  stop?: () => Promise<void>
}

/**
 * 选中映射：只发布标识与摘要；实体由界面按 id 从自己的数据里取。
 *
 * 打开了运行就发布 `flow.run`（停止、复制摘要、打开目录都作用于它）；
 * 只选中了 Flow 包、还没启动过运行时发布 `flow.package`，这样「在文件模块打开 Flow 目录」
 * 不必先跑一次才能用。两者都没有时不发布。
 */
export function selectionFor(
  run: RunView | undefined,
  flows: Array<{ id: string; name: string }>,
  flowId: string | null = null,
): Selection | null {
  if (run !== undefined) {
    const flowName = flows.find((flow) => flow.id === run.flowId)?.name ?? run.flowId
    return {
      kind: FLOW_KIND,
      id: run.runId,
      label: `${flowName} · ${statusLabel(run.status)}`,
    }
  }
  if (flowId === null) return null
  const flowName = flows.find((flow) => flow.id === flowId)?.name ?? flowId
  return { kind: PACKAGE_KIND, id: flowId, label: flowName }
}

export function buildRunMarkdown(run: RunView, flowName: string): string {
  const lines = [
    `# ${flowName || run.flowId} 运行 ${run.runId}`,
    '',
    `- 状态：${statusLabel(run.status)}`,
    `- 开始：${run.startedAt}`,
    `- 步骤：${run.stepCount}`,
  ]
  if (run.failure !== undefined)
    lines.push(`- 失败：${run.failure.code} ${run.failure.message}`)
  if (run.pending !== undefined) {
    lines.push('', `## 等待确认：${run.pending.nodeName}`, '', run.pending.message, '')
    lines.push(`可选：${run.pending.options.join(' / ')}`)
  }
  if (run.steps.length > 0) {
    lines.push('', '## 已完成的步骤')
    for (const step of run.steps) lines.push(`- ${step.nodeRef} → ${step.result.outcome}`)
  }
  if (Object.keys(run.variables).length > 0) {
    lines.push('', '## 变量', '```json', JSON.stringify(run.variables, null, 2), '```')
  }
  return `${lines.join('\n')}\n`
}

/** 操作在 React 之外执行，读的是渲染时快照；测试直接注入一份。 */
export function createActions(
  options: FlowModuleOptions,
  read: () => ActionSnapshot,
): WorkspaceAction[] {
  const appliesToFlow = (selection: Selection | null) =>
    selection !== null && FLOW_SELECTION_KINDS.includes(selection.kind)
  return [
    {
      id: 'stop-run',
      label: '停止这次运行',
      appliesTo: (selection) => selection?.kind === FLOW_KIND,
      disabledReason: () => {
        const run = read().run
        if (run === undefined) return '运行不在当前视图里'
        return stopDisabledReason(run)
      },
      confirm: (selection) => `会把这次运行标记为停止，不再继续推进：\n${selection.id}\n继续？`,
      run: async () => {
        const { stop } = read()
        if (stop === undefined) throw new Error('运行不在当前视图里')
        await stop()
      },
    },
    {
      id: 'copy-run-summary',
      label: '复制运行摘要',
      appliesTo: (selection) => selection?.kind === FLOW_KIND,
      disabledReason: () => (read().run === undefined ? '运行不在当前视图里' : null),
      run: async () => {
        const { run, flowName } = read()
        if (run === undefined) throw new Error('运行不在当前视图里')
        await copyText(buildRunMarkdown(run, flowName ?? ''))
      },
    },
    {
      id: 'open-flow-in-files',
      label: '在文件模块打开 Flow 目录',
      appliesTo: appliesToFlow,
      disabledReason: (_selection: Selection, shell: ShellHandle) => {
        if (options.openRootInFiles === undefined) return '组合根未接入文件模块能力'
        if (!shell.enabled('fs-web')) return '文件模块未在当前 profile 中启用'
        if (read().flowDir === undefined) return '还没有选中 Flow 包'
        return null
      },
      confirm: () => `会在文件模块里登记并打开目录\n${flowDirUri()}\n继续？`,
      run: async (_selection: Selection, shell: ShellHandle) => {
        const { flowDir } = read()
        if (options.openRootInFiles === undefined)
          throw new Error('组合根未接入文件模块能力')
        if (flowDir === undefined) throw new Error('还没有选中 Flow 包')
        await options.openRootInFiles(flowDirUri())
        shell.reveal('fs-web')
      },
    },
  ]

  /** Flow 包目录在服务端是裸路径（给引擎的执行路径）；跨模块传位置 URI。 */
  function flowDirUri(): string {
    const { flowDir } = read()
    return flowDir === undefined ? '' : parse(flowDir).uri
  }
}
