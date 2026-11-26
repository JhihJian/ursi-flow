import { describe, expect, it, vi } from 'vitest'
import type { Selection, ShellHandle } from '@ursi/workspace-shell'
import type { RunView } from '../api'
import {
  FLOW_KIND,
  buildRunMarkdown,
  createActions,
  selectionFor,
  type ActionSnapshot,
} from './actions'

const run = (overrides: Partial<RunView> = {}): RunView => ({
  runId: 'run-1',
  flowId: 'code-change',
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

const shell = (enabled: boolean): ShellHandle => ({
  enabled: () => enabled,
  reveal: vi.fn(),
})

describe('选中映射', () => {
  it('发布运行标识与「Flow 名 · 状态」摘要', () => {
    expect(selectionFor(run(), [{ id: 'code-change', name: '代码修改' }])).toEqual({
      kind: FLOW_KIND,
      id: 'run-1',
      label: '代码修改 · 等待确认',
    })
  })

  it('没有运行时不发布选中', () => {
    expect(selectionFor(undefined, [])).toBeNull()
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
    expect(text).toContain('/.ursi/flow/code-change')

    const target = shell(true)
    await withFiles[2].run(selection, target)
    expect(openRoot).toHaveBeenCalledWith('/home/me/.ursi/flow/code-change')
    expect(target.reveal).toHaveBeenCalledWith('fs-web')
  })

  it('停止操作调用快照里的停止函数', async () => {
    const stop = vi.fn(async () => {})
    const actions = createActions({ apiBaseUrl: '' }, () => ({ run: run(), stop }))
    expect(actions[0].disabledReason?.(selection, shell(true))).toBeNull()
    await actions[0].run(selection, shell(true))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('所有操作只作用于本模块的选中类型', () => {
    const read = (): ActionSnapshot => ({ run: run() })
    for (const action of createActions({ apiBaseUrl: '' }, read)) {
      expect(action.appliesTo(selection, shell(true))).toBe(true)
      expect(action.appliesTo({ kind: 'todo.task', id: 'x' }, shell(true))).toBe(false)
      expect(action.appliesTo(null, shell(true))).toBe(false)
    }
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
