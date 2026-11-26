import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

/**
 * 挂载后拉一次配置与列表：验证 Provider 的加载顺序、
 * 自动选中第一个可执行 Flow，以及侧边栏/工作区读到同一份数据。
 */
describe('独立入口挂载', () => {
  beforeAll(() => {
    // React 19 在非测试环境会拒绝 act：显式打开。
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('自动选中第一个可执行 Flow 并渲染结构与运行清单', async () => {
    const responses: Record<string, unknown> = {
      '/api/config': {
        flowHome: '/home/me/.ursi/flow',
        stateDir: '/home/me/.ursi/flow-web',
        runsRoot: '/home/me/.ursi/flow-web/runs',
        executors: [
          { id: 'fake', title: 'Fake 执行器', description: '按第一条结果边作答' },
          { id: 'pi', title: 'Pi 执行器', description: '真实 Agent' },
        ],
        defaultExecutor: 'fake',
      },
      '/api/flows': {
        flowHome: '/home/me/.ursi/flow',
        flows: [
          { id: 'broken', dir: '/home/me/.ursi/flow/broken', name: 'broken', description: '', nodeCount: 0, variableCount: 0, valid: false, error: '缺少 FLOW.md' },
          { id: 'code-change', dir: '/home/me/.ursi/flow/code-change', name: '代码修改与验证', description: '改完再验证', nodeCount: 1, variableCount: 1, valid: true },
        ],
      },
      '/api/flows/code-change': {
        flow: {
          id: 'code-change',
          dir: '/home/me/.ursi/flow/code-change',
          path: '/home/me/.ursi/flow/code-change/FLOW.md',
          startNodeRef: 'change',
          name: '代码修改与验证',
          description: '改完再验证',
          nodeCount: 1,
          variableCount: 1,
          valid: true,
          variables: [{ name: '任务', description: '本次目标', required: true }],
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
        },
      },
      '/api/runs': { runs: [] },
    }
    vi.stubGlobal('fetch', async (input: string) => {
      const body = responses[new URL(input, 'http://localhost').pathname]
      return new Response(JSON.stringify(body ?? {}), {
        status: body === undefined ? 404 : 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    await act(async () => {
      root.render(<App apiBaseUrl="/api" />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const text = container.textContent ?? ''
    expect(text).toContain('代码修改与验证')
    expect(text).toContain('broken')
    expect(text).toContain('启动变量')
    expect(text).toContain('完成修改')
    // 结构默认画成图：有 SVG、有节点与切回列表的入口。
    const svg = container.querySelector('svg.flow-graph-canvas')
    expect(svg).not.toBeNull()
    expect(svg?.textContent).toContain('完成修改')
    expect(svg?.textContent).toContain('结束')
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === '列表',
      ),
    ).toBe(true)

    // 点节点：出边高亮，其余边淡出。
    const node = Array.from(container.querySelectorAll('.flow-graph-node')).find(
      (element) => element.getAttribute('aria-label')?.includes('完成修改'),
    )
    expect(node).toBeDefined()
    await act(async () => {
      node!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelectorAll('.flow-graph-edge.is-active').length).toBeGreaterThan(0)
    expect(container.querySelector('.flow-graph-canvas')?.classList.contains('has-selection')).toBe(true)

    await act(async () => {
      node!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelectorAll('.flow-graph-edge.is-active').length).toBe(0)
    expect(text).toContain('还没有运行记录')
    expect(text).toContain('Fake 执行器（fake）')
    expect(text).toContain('Pi 执行器（pi）')
  })
})

describe('启动运行与人工确认', () => {
  it('填变量启动、在页面上作答并把运行推进到完成', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const flow = {
      id: 'gate',
      dir: '/home/me/.ursi/flow/gate',
      path: '/home/me/.ursi/flow/gate/FLOW.md',
      startNodeRef: 'prepare',
      name: '确认门禁',
      description: '',
      nodeCount: 2,
      variableCount: 0,
      valid: true,
      variables: [],
      nodes: [
        {
          ref: 'prepare',
          name: '准备',
          kind: 'agent' as const,
          prompt: '准备材料',
          outcomes: [{ name: '已准备', description: '', destination: { kind: 'node' as const, name: '确认' } }],
        },
      ],
      parallels: [],
    }
    const runOf = (status: string, extra: Record<string, unknown> = {}) => ({
      runId: 'run-1',
      flowId: 'gate',
      executor: 'fake',
      status,
      startedAt: '2024-03-04T05:06:07.000Z',
      updatedAt: '2024-03-04T05:06:08.000Z',
      stepCount: 1,
      variables: {},
      steps: [],
      events: [],
      active: false,
      ...extra,
    })

    const state: { calls: string[]; bodies: string[] } = { calls: [], bodies: [] }
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const path = new URL(input, 'http://localhost').pathname
      const method = init?.method ?? 'GET'
      state.calls.push(`${method} ${path}`)
      const reply = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      if (path === '/api/config')
        return reply({
          flowHome: '/home/me/.ursi/flow',
          stateDir: '/s',
          runsRoot: '/s/runs',
          executors: [
            { id: 'fake', title: 'Fake 执行器', description: '按第一条结果边作答' },
          ],
          defaultExecutor: 'fake',
        })
      if (path === '/api/flows')
        return reply({ flowHome: '/home/me/.ursi/flow', flows: [flow] })
      if (path === '/api/flows/gate') return reply({ flow })
      if (path === '/api/runs' && method === 'GET') return reply({ runs: [] })
      if (path === '/api/runs' && method === 'POST') {
        state.bodies.push(String(init?.body ?? ''))
        return reply({ runId: 'run-1' })
      }
      if (path === '/api/runs/run-1' && method === 'GET')
        return reply({
          run: runOf('awaiting_input', {
            pending: {
              stepId: 's1',
              nodeRef: 'gate',
              nodeName: '确认',
              message: '请确认准备结果。',
              options: ['通过', '退回'],
            },
          }),
        })
      if (path === '/api/runs/run-1/confirm')
        return reply({ run: runOf('completed', { stepCount: 2 }) })
      return new Response('{}', { status: 404 })
    })

    await act(async () => {
      root.render(<App apiBaseUrl="/api" />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const start = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '开始运行',
    )
    expect(start).toBeDefined()
    await act(async () => {
      start!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.textContent).toContain('等待确认')
    expect(container.textContent).toContain('请确认准备结果。')

    const approve = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '通过',
    )
    expect(approve).toBeDefined()
    await act(async () => {
      approve!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('已完成')
    // 已完成的运行没有下一步：继续与停止都必须禁用。
    for (const label of ['继续', '停止']) {
      const action = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === label,
      )
      expect(action?.disabled, label).toBe(true)
    }
    expect(state.calls).toContain('POST /api/runs/run-1/confirm')
    expect(JSON.parse(state.bodies[0])).toMatchObject({ executor: 'fake' })

    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
})
