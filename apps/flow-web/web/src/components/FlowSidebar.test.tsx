import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { build, parse } from '@ursi/location'
import type { DirListing, ListDirFn } from '@ursi/directory-picker'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowClient, FlowConfig } from '../api'
import { FlowSidebar } from './FlowSidebar'
import { FlowHostContext } from '../host'
import { FlowProvider } from '../store'

/**
 * flow home 的编辑区：输入框常在，选目录器只在组合根注入了 `host.listDir` 时出现；
 * 从选目录器选中后把位置 URI 交给保存接口。
 */

const config: FlowConfig = {
  flowHome: 'file:///home/me/.ursi/flow',
  stateDir: '/home/me/.ursi/flow-web',
  runsRoot: '/home/me/.ursi/flow-web/runs',
  executors: [{ id: 'fake', title: 'Fake 执行器', description: '' }],
  defaultExecutor: 'fake',
}

function fakeClient(overrides: Partial<FlowClient> = {}): FlowClient {
  return {
    getConfig: async () => config,
    setFlowHome: async (flowHome) => ({ ...config, flowHome }),
    listFlows: async () => ({ flowHome: config.flowHome, flows: [] }),
    getFlow: async () => {
      throw new Error('no flow')
    },
    listRuns: async () => [],
    startRun: async () => {
      throw new Error('no start')
    },
    getRun: async () => {
      throw new Error('no run')
    },
    confirm: async () => {
      throw new Error('no run')
    },
    resume: async () => {
      throw new Error('no run')
    },
    stopRun: async () => {
      throw new Error('no run')
    },
    ...overrides,
  }
}

const noop = () => undefined
const sidebarProps = { collapsed: false, collapse: noop, expand: noop }

describe('flow home 编辑区', () => {
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

  async function render(client: FlowClient, host: { listDir?: ListDirFn } = {}): Promise<void> {
  await act(async () => {
    root.render(
      <FlowHostContext.Provider value={host}>
        <FlowProvider client={client}>
          <FlowSidebar {...sidebarProps} />
        </FlowProvider>
      </FlowHostContext.Provider>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  }

function buttonOf(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === label,
  )
}

  it('显示当前位置 URI；点「修改」出现输入框，占位是本机路径示例', async () => {
    await render(fakeClient())
    expect(container.textContent).toContain('file:///home/me/.ursi/flow')
    expect(buttonOf(container, '浏览目录…')).toBeUndefined()

    await act(async () => {
      buttonOf(container, '修改')!.click()
    })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="flow home 目录"]')
    expect(input?.value).toBe('file:///home/me/.ursi/flow')
    expect(input?.placeholder).toBe('路径，如 /data/flows')
  })

  it('注入了 listDir 时出现「浏览目录…」，选中后把位置 URI 交给保存接口并收起编辑区', async () => {
    const setFlowHome = vi.fn(async (flowHome: string) => ({ ...config, flowHome }))
    // 只认 URI；`~` 这类简写按 home 解析，与服务端口径一致。
    const listDir = vi.fn<ListDirFn>(async (target) => {
      const location = parse(target, { home: '/home/me' })
      const listing: DirListing = { location, parent: build('file', '/'), entries: [{ name: 'flows' }] }
      return listing
    })
    await render(fakeClient({ setFlowHome }), { listDir })

    await act(async () => {
      buttonOf(container, '修改')!.click()
    })
    const browse = buttonOf(container, '浏览目录…')
    expect(browse).toBeDefined()
    await act(async () => {
      browse!.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(listDir).toHaveBeenCalledWith('file:///home/me/.ursi/flow')
    expect(container.querySelector('.dp')).not.toBeNull()
    // 只列子目录，不渲染设备切换：flow home 必须本机。
    expect(container.querySelector('.dp-device')).toBeNull()
    expect(container.textContent).toContain('flows')

    // 进入子目录再确认。
    await act(async () => {
      buttonOf(container, 'flows')!.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      buttonOf(container, '使用此目录')!.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(setFlowHome).toHaveBeenCalledWith('file:///home/me/.ursi/flow/flows')
    expect(buttonOf(container, '浏览目录…')).toBeUndefined()
    expect(container.textContent).toContain('file:///home/me/.ursi/flow/flows')
  })

  it('选目录器里取消与输入框旁的取消同一语义：收起整个编辑区', async () => {
    const listDir = vi.fn<ListDirFn>(async (target) => ({
      location: parse(target, { home: '/home/me' }),
      parent: null,
      entries: [],
    }))
    await render(fakeClient(), { listDir })
    await act(async () => {
      buttonOf(container, '修改')!.click()
    })
    await act(async () => {
      buttonOf(container, '浏览目录…')!.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      buttonOf(container, '取消')!.click()
    })
    expect(container.querySelector('.dp')).toBeNull()
    expect(container.querySelector('input[aria-label="flow home 目录"]')).toBeNull()
    expect(buttonOf(container, '修改')).toBeDefined()
    expect(container.textContent).toContain('file:///home/me/.ursi/flow')
    expect(listDir).toHaveBeenCalledTimes(1)
  })
})
