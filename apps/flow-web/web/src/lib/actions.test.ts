import { describe, expect, it, vi } from 'vitest'
import type { Selection, ShellHandle } from '@ursi/workspace-shell'
import type { RunView } from '../api'
import {
  FLOW_KIND,
  PACKAGE_KIND,
  buildRunMarkdown,
  createActions,
  selectionFor,
  type ActionSnapshot,
} from './actions'

const run = (overrides: Partial<RunView> = {}): RunView => ({
  runId: 'run-1',
  flowId: 'code-change',
  executor: 'fake',
  status: 'awaiting_input',
  startedAt: '2024-03-04T05:06:07.000Z',
  updatedAt: '2024-03-04T05:06:08.000Z',
  stepCount: 1,
  variables: { 任务: '补测试' },
  steps: [{ stepId: 's1', nodeRef: 'change', result: { outcome: '已修改' } }],
  pending: {
    stepId: 's1',
    nodeRef: 'gate',
    nodeName: '确认',
    message: '请确认修改',
    options: ['通过', '退回'],
  },
  events: [],
  active: false,
  ...overrides,
})

const selection: Selection = { kind: FLOW_KIND, id: 'run-1', label: '代码修改 · 等待确认' }
const packageSelection: Selection = { kind: PACKAGE_KIND, id: 'code-change', label: '代码修改' }
const flows = [{ id: 'code-change', name: '代码修改' }]

const shell = (enabled: boolean): ShellHandle => ({
  enabled: () => enabled,
  reveal: vi.fn(),
})

describe('选中映射', () => {
  it('打开了运行就发布运行标识与「Flow 名 · 状态」摘要', () => {
    expect(selectionFor(run(), flows)).toEqual({
      kind: FLOW_KIND,
      id: 'run-1',
      label: '代码修改 · 等待确认',
    })
  })

  it('只选中了 Flow 包、没有运行时发布 flow.package', () => {
    expect(selectionFor(undefined, flows, 'code-change')).toEqual({
      kind: PACKAGE_KIND,
      id: 'code-change',
      label: '代码修改',
    })
  })

  it('既没有运行也没有选中 Flow 包时不发布选中', () => {
    expect(selectionFor(undefined, flows)).toBeNull()
    expect(selectionFor(undefined, [], null)).toBeNull()
  })
})

describe('操作可用性', () => {
  it('运行还在执行时不能停止，已完成也不算可停止', () => {
    const actions = createActions({ apiBaseUrl: '' }, () => ({
      run: run({ active: true }),
    }))
    expect(actions[0].disabledReason?.(selection, shell(true))).toBe('运行还在执行')

    const done = createActions({ apiBaseUrl: '' }, () => ({
      run: run({ status: 'completed', pending: undefined }),
    }))
    expect(done[0].disabledReason?.(selection, shell(true))).toBe('运行已经结束')
  })

  it('没有接入文件模块时给出禁用原因，接入后可执行并跳到文件模块', async () => {
    const without = createActions({ apiBaseUrl: '' }, () => ({
      run: run(),
      flowDir: '/home/me/.ursi/flow/code-change',
    }))
    expect(without[2].disabledReason?.(selection, shell(true))).toBe(
      '组合根未接入文件模块能力',
    )

    const openRoot = vi.fn(async () => ({ id: 'root-1', label: 'code-change' }))
    const withFiles = createActions({ apiBaseUrl: '', openRootInFiles: openRoot }, () => ({
      run: run(),
      flowDir: '/home/me/.ursi/flow/code-change',
    }))
    expect(withFiles[2].disabledReason?.(selection, shell(false))).toBe(
      '文件模块未在当前 profile 中启用',
    )
    expect(withFiles[2].disabledReason?.(selection, shell(true))).toBeNull()
    const confirm = withFiles[2].confirm
    const text = typeof confirm === 'function' ? confirm(selection, shell(true)) : (confirm ?? '')
    expect(text).toContain('file:///home/me/.ursi/flow/code-change')

    const target = shell(true)
    await withFiles[2].run(selection, target)
    expect(openRoot).toHaveBeenCalledWith('file:///home/me/.ursi/flow/code-change')
    expect(openRoot).not.toHaveBeenCalledWith('/home/me/.ursi/flow/code-change')
    expect(target.reveal).toHaveBeenCalledWith('fs-web')
  })

  it('没启动过运行、只选中 Flow 包时也能打开 Flow 目录，传的仍是位置 URI', async () => {
    const openRoot = vi.fn(async () => ({ id: 'root-1', label: 'code-change' }))
    const actions = createActions({ apiBaseUrl: '', openRootInFiles: openRoot }, () => ({
      flowDir: '/srv/flows/code-change',
    }))
    expect(actions[2].appliesTo(packageSelection, shell(true))).toBe(true)
    expect(actions[2].disabledReason?.(packageSelection, shell(true))).toBeNull()

    const target = shell(true)
    await actions[2].run(packageSelection, target)
    expect(openRoot).toHaveBeenCalledWith('file:///srv/flows/code-change')
    expect(target.reveal).toHaveBeenCalledWith('fs-web')
  })

  it('停止操作调用快照里的停止函数', async () => {
    const stop = vi.fn(async () => {})
    const actions = createActions({ apiBaseUrl: '' }, () => ({ run: run(), stop }))
    expect(actions[0].disabledReason?.(selection, shell(true))).toBeNull()
    await actions[0].run(selection, shell(true))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('所有操作只作用于本模块的选中类型；运行类操作不作用于只选了包的选中', () => {
    const read = (): ActionSnapshot => ({ run: run() })
    for (const action of createActions({ apiBaseUrl: '' }, read)) {
      expect(action.appliesTo(selection, shell(true))).toBe(true)
      expect(action.appliesTo({ kind: 'todo.task', id: 'x' }, shell(true))).toBe(false)
      expect(action.appliesTo(null, shell(true))).toBe(false)
    }
    const [stop, copy] = createActions({ apiBaseUrl: '' }, read)
    expect(stop.appliesTo(packageSelection, shell(true))).toBe(false)
    expect(copy.appliesTo(packageSelection, shell(true))).toBe(false)
  })
})

describe('运行摘要', () => {
  it('带状态、步骤、待决确认与变量', () => {
    const markdown = buildRunMarkdown(run(), '代码修改')
    expect(markdown).toContain('# 代码修改 运行 run-1')
    expect(markdown).toContain('- 状态：等待确认')
    expect(markdown).toContain('## 等待确认：确认')
    expect(markdown).toContain('可选：通过 / 退回')
    expect(markdown).toContain('- change → 已修改')
    expect(markdown).toContain('"任务": "补测试"')
  })

  it('失败时写出错误码与原因', () => {
    const markdown = buildRunMarkdown(
      run({
        status: 'failed',
        pending: undefined,
        failure: { code: 'executor_failed', message: '执行器出错' },
      }),
      '代码修改',
    )
    expect(markdown).toContain('- 失败：executor_failed 执行器出错')
  })
})
