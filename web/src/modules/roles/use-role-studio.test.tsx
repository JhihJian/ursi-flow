import { createContext, useContext, type ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/shared/api'
import type { Connection, Role } from '@/shared/api/types'
import { finishConfirmation, useFeedbackStore } from '@/shared/stores/feedback'
import { useRoleStudio } from './use-role-studio'

const connection: Connection = { id: 'connection-1', name: '团队模型', provider: 'openai', baseUrl: 'https://api.example.com', model: 'gpt-4.1', credentialRef: 'env:KEY', updatedAt: '2026-01-01' }

function makeRole(id: string): Role {
  return {
    id,
    name: id,
    description: '',
    icon: 'robot',
    color: '#8b5cf6',
    systemPrompt: '认真分析问题',
    executor: 'codex',
    model: connection.model,
    connectionId: connection.id,
    skills: [{ name: '审查', content: '检查边界条件' }],
    mcpServers: [],
    updatedAt: '2026-01-01',
  }
}

function clone<T>(data: T): T { return JSON.parse(JSON.stringify(data)) as T }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

const SlotContext = createContext<ReactNode>(null)
function RouteSlot() {
  return <>{useContext(SlotContext)}</>
}

/** 让 useRoleStudio 跑在 data router 内，路由元素渲染 renderHook 传入的子树。 */
function createHarness(path: string) {
  const router = createMemoryRouter(
    [{ path: '/roles', element: <RouteSlot /> }, { path: '/elsewhere', element: <div /> }],
    { initialEntries: [path] },
  )
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SlotContext.Provider value={children}>
      <RouterProvider router={router} />
    </SlotContext.Provider>
  )
  return { router, wrapper }
}

const confirmation = () => useFeedbackStore.getState().confirmation
const toasts = () => useFeedbackStore.getState().toasts

type Studio = ReturnType<typeof useRoleStudio>

function snapshot(result: { current: Studio }) {
  const studio = result.current
  return clone({
    roles: studio.roles,
    draft: studio.draft,
    selectedId: studio.selectedId,
    dirty: studio.dirty,
    busy: studio.busy,
    createOpen: studio.createOpen,
    createName: studio.createName,
    createError: studio.createError,
    actionError: studio.actionError,
  })
}

function location(router: ReturnType<typeof createHarness>['router']) {
  return `${router.state.location.pathname}${router.state.location.search}`
}

let stored: Role[]
let router: ReturnType<typeof createHarness>['router']

beforeEach(() => {
  stored = [makeRole('role-a'), makeRole('role-b')]
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path === '/connections') return clone([connection])
    if (path === '/roles') return clone(stored)
    const role = stored.find((item) => path === `/roles/${item.id}`)
    if (!role) throw new Error('角色不存在')
    return clone(role)
  })
  vi.spyOn(api, 'put').mockImplementation(async (_path, payload) => {
    const role = clone(payload as Role)
    stored = stored.map((item) => item.id === role.id ? role : item)
    return clone(role)
  })
  vi.spyOn(api, 'delete').mockImplementation(async (path) => {
    stored = stored.filter((item) => path !== `/roles/${item.id}`)
  })
})

afterEach(() => {
  cleanup()
  finishConfirmation(false)
  useFeedbackStore.setState({ toasts: [] })
  vi.restoreAllMocks()
})

async function setup(path = '/roles') {
  const harness = createHarness(path)
  router = harness.router
  const view = renderHook(() => useRoleStudio(), { wrapper: harness.wrapper })
  await waitFor(() => expect(view.result.current.draft?.id).toBe(path.includes('role-b') ? 'role-b' : 'role-a'))
  return view
}

describe('角色工作室异步操作生命周期', () => {
  for (const action of ['create', 'copy', 'remove', 'save'] as const) {
    it.each(['resolve', 'reject'] as const)(`${action} 卸载后 %s 不改写状态、其他域路由或通知`, async (outcome) => {
      const { result } = await setup('/roles?id=role-a')
      const pending = deferred<Role>()
      if (action === 'create' || action === 'copy') vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise)
      if (action === 'save') {
        vi.mocked(api.put).mockReturnValueOnce(pending.promise)
        act(() => { result.current.updateDraft({ name: '修改名称' }) })
      }
      if (action === 'remove') vi.mocked(api.delete).mockReturnValueOnce(pending.promise.then(() => undefined))
      if (action === 'create') {
        await act(async () => { await result.current.openCreate() })
        act(() => { result.current.setCreateName('新角色') })
      }

      let operation!: Promise<void>
      act(() => { operation = result.current[action]() })
      if (action === 'remove') {
        await act(async () => { finishConfirmation(true) })
      }
      await waitFor(() => expect(result.current.busy).toBe(true))

      const leaving = router.navigate('/elsewhere?section=keep')
      if (action === 'create' || action === 'save') {
        await waitFor(() => expect(confirmation()).not.toBeNull())
        await act(async () => { finishConfirmation(true) })
      }
      await leaving
      await waitFor(() => expect(location(router)).toBe('/elsewhere?section=keep'))
      await act(async () => { await Promise.resolve() })

      const state = snapshot(result)
      const navigate = vi.spyOn(router, 'navigate')
      if (outcome === 'resolve') pending.resolve(makeRole('late-role'))
      else pending.reject(new Error('迟到的错误'))
      await operation

      expect(navigate).not.toHaveBeenCalled()
      expect(location(router)).toBe('/elsewhere?section=keep')
      expect(snapshot(result)).toEqual(state)
      expect(toasts()).toEqual([])
    })
  }

  it.each(['remove', 'openCreate', 'closeCreate', 'discard'] as const)('%s 确认期间卸载后不再继续操作', async (action) => {
    const { result, unmount } = await setup('/roles?id=role-a')
    if (action === 'closeCreate') {
      await act(async () => { await result.current.openCreate() })
      act(() => { result.current.setCreateName('待创建') })
    } else {
      act(() => { result.current.updateDraft({ name: '未保存' }) })
    }

    let operation!: Promise<void>
    act(() => { operation = result.current[action]() })
    await waitFor(() => expect(confirmation()).not.toBeNull())
    const state = snapshot(result)
    unmount()
    await act(async () => {
      finishConfirmation(true)
      await operation
    })

    expect(api.delete).not.toHaveBeenCalled()
    expect(snapshot(result)).toEqual(state)
    expect(toasts()).toEqual([])
  })

  it.each(['create', 'copy'] as const)('%s 正常完成后选择返回的角色并显示成功通知', async (action) => {
    const { result } = await setup('/roles?id=role-a')
    const role = makeRole('new-role')
    vi.spyOn(api, 'post').mockImplementationOnce(async () => { stored.push(role); return clone(role) })
    if (action === 'create') {
      await act(async () => { await result.current.openCreate() })
      act(() => { result.current.setCreateName('新角色') })
    }
    await act(async () => { await result.current[action]() })

    await waitFor(() => expect(location(router)).toBe('/roles?id=new-role'))
    await waitFor(() => expect(result.current.selectedId).toBe('new-role'))
    expect(result.current.busy).toBe(false)
    expect(toasts()).toHaveLength(1)
  })

  it('角色导航仍在等待时卸载，导航结束后不弹出迟到通知', async () => {
    const { result } = await setup('/roles?id=role-a')
    vi.spyOn(api, 'post').mockResolvedValueOnce(makeRole('copy-role'))
    const navigation = deferred<void>()
    const navigate = vi.spyOn(router, 'navigate').mockReturnValueOnce(navigation.promise)
    let operation!: Promise<void>
    await act(async () => { operation = result.current.copy() })
    await waitFor(() => expect(navigate).toHaveBeenCalled())

    await act(async () => { await router.navigate('/elsewhere') })
    navigation.resolve()
    await operation

    expect(toasts()).toEqual([])
  })
})

describe('角色工作室草稿与导航', () => {
  it('读取深链接角色，编辑技能不会提前改写列表或持久化记录，保存后重新读取一致', async () => {
    const { result } = await setup('/roles?id=role-b')
    expect(result.current.selectedId).toBe('role-b')
    act(() => { result.current.updateSkill(0, { content: '新增审查规则' }) })
    expect(result.current.dirty).toBe(true)
    expect(result.current.roles[1]!.skills[0]!.content).toBe('检查边界条件')
    expect(stored[1]!.skills[0]!.content).toBe('检查边界条件')

    await act(async () => { await result.current.save() })

    expect(result.current.dirty).toBe(false)
    expect(stored[1]!.skills[0]!.content).toBe('新增审查规则')
    expect(toasts().map((toast) => toast.message)).toEqual(['角色配置已保存'])

    await act(async () => { await router.navigate('/roles?id=role-a') })
    await waitFor(() => expect(result.current.draft?.id).toBe('role-a'))
    await act(async () => { await router.navigate('/roles?id=role-b') })
    await waitFor(() => expect(result.current.draft?.id).toBe('role-b'))
    expect(result.current.draft!.skills[0]!.content).toBe('新增审查规则')
  })

  it('取消角色切换保留草稿，确认后才加载另一个角色', async () => {
    const { result } = await setup('/roles')
    act(() => { result.current.updateDraft({ name: '尚未保存' }) })

    let switched!: Promise<void>
    act(() => { switched = result.current.selectRole('role-b') })
    await waitFor(() => expect(confirmation()?.title).toContain('未保存'))
    await act(async () => {
      finishConfirmation(false)
      await switched
    })
    await waitFor(() => expect(result.current.draft?.name).toBe('尚未保存'))
    await waitFor(() => expect(location(router)).toBe('/roles?id=role-a'))

    let accepted!: Promise<void>
    act(() => { accepted = result.current.selectRole('role-b') })
    await waitFor(() => expect(confirmation()?.title).toContain('未保存'))
    await act(async () => {
      finishConfirmation(true)
      await accepted
    })
    await waitFor(() => expect(result.current.draft?.id).toBe('role-b'))
    expect(result.current.dirty).toBe(false)
  })

  it('保存失败保留草稿，字段校验定位对应标签页', async () => {
    const { result } = await setup('/roles')
    act(() => { result.current.updateDraft({ systemPrompt: '' }) })
    await act(async () => { await result.current.save() })
    expect(result.current.tab).toBe('prompt')
    expect(api.put).not.toHaveBeenCalled()

    act(() => { result.current.updateDraft({ systemPrompt: '新的提示词' }) })
    vi.mocked(api.put).mockRejectedValueOnce(new Error('保存失败，请重试'))
    await act(async () => { await result.current.save() })
    expect(result.current.actionError).toContain('保存失败')
    expect(result.current.draft!.systemPrompt).toBe('新的提示词')
    expect(result.current.dirty).toBe(true)
  })

  it('删除最后一个深链接角色后清空编辑器，不重新请求已删除的详情', async () => {
    stored = [makeRole('role-a')]
    const { result } = await setup('/roles?id=role-a')
    vi.mocked(api.get).mockClear()

    let removing!: Promise<void>
    act(() => { removing = result.current.remove() })
    await waitFor(() => expect(confirmation()).not.toBeNull())
    await act(async () => {
      finishConfirmation(true)
      await removing
    })
    await waitFor(() => expect(location(router)).toBe('/roles'))

    expect(result.current.roles).toEqual([])
    expect(result.current.draft).toBeNull()
    expect(result.current.detailError).toBe('')
    expect(router.state.location.search).toBe('')
    expect(toasts().map((toast) => toast.message)).toEqual(['角色已删除'])
    expect(api.get).not.toHaveBeenCalledWith('/roles/role-a', expect.anything())
  })

  it('被引用的角色删除失败，当前定义和草稿保留', async () => {
    const { result } = await setup('/roles')
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('角色仍被流程引用，请先调整流程。'))
    act(() => { result.current.updateDraft({ name: '未保存的名称' }) })

    let removing!: Promise<void>
    act(() => { removing = result.current.remove() })
    await waitFor(() => expect(confirmation()).not.toBeNull())
    await act(async () => {
      finishConfirmation(true)
      await removing
    })

    expect(result.current.actionError).toContain('被流程引用')
    expect(result.current.draft!.name).toBe('未保存的名称')
    expect(result.current.roles).toHaveLength(2)
  })
})
