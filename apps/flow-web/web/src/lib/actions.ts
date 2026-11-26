import type {
  Selection,
  ShellHandle,
  WorkspaceAction,
} from '@ursi/workspace-shell'
import type { RunView } from '../api'
import { copyText } from './clipboard'
import { statusLabel } from './flow'

/** flow 模块对外发布的选中类型。 */
export const FLOW_KIND = 'flow.run'

export interface FlowModuleOptions {
  /** 同源 API 前缀，由宿主注入。 */
  apiBaseUrl: string
  /** 在文件模块里登记并打开某个目录；组合根注入，模块不 import 文件模块。 */
  openRootInFiles?: (root: string) => Promise<{ id: string; label: string }>
}

export interface ActionSnapshot {
  run?: RunView
  flowDir?: string
  flowName?: string
  stop?: () => Promise<void>
}

/** 选中映射：只发布运行标识与摘要；实体由界面按 id 从自己的数据里取。 */
export function selectionFor(
  run: RunView | undefined,
  flows: Array<{ id: string; name: string }>,
): Selection | null {
  if (run === undefined) return null
  const flowName = flows.find((flow) => flow.id === run.flowId)?.name ?? run.flowId
  return { kind: FLOW_KIND, id: run.runId, label: `${flowName} · ${statusLabel(run.status)}` }
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
  return [
    {
      id: 'stop-run',
      label: '停止这次运行',
      appliesTo: (selection) => selection?.kind === FLOW_KIND,
      disabledReason: () => {
        const run = read().run
        if (run === undefined) return '运行不在当前视图里'
        if (run.active) return '运行还在执行'
        if (run.status === 'completed') return '运行已经结束'
        return null
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
      appliesTo: (selection) => selection?.kind === FLOW_KIND,
      disabledReason: (_selection: Selection, shell: ShellHandle) => {
        if (options.openRootInFiles === undefined) return '组合根未接入文件模块能力'
        if (!shell.enabled('fs-web')) return '文件模块未在当前 profile 中启用'
        if (read().flowDir === undefined) return '还没有选中 Flow 包'
        return null
      },
      confirm: () => `会在文件模块里登记并打开目录\n${read().flowDir ?? ''}\n继续？`,
      run: async (_selection: Selection, shell: ShellHandle) => {
        const { flowDir } = read()
        if (options.openRootInFiles === undefined)
          throw new Error('组合根未接入文件模块能力')
        if (flowDir === undefined) throw new Error('还没有选中 Flow 包')
        await options.openRootInFiles(flowDir)
        shell.reveal('fs-web')
      },
    },
  ]
}
