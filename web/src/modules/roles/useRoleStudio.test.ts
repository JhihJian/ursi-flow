import { defineComponent } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api'
import type { Connection, Role } from '@/shared/api/types'
import { confirmation, finishConfirmation, toasts } from '@/shared/composables/feedback'
import { useRoleStudio } from './useRoleStudio'

const connection: Connection = { id: 'connection-1', name: '团队模型', provider: 'openai', baseUrl: 'https://api.example.com', model: 'gpt-4.1', credentialRef: 'env:KEY', updatedAt: '2026-01-01' }
function makeRole(id: string): Role {
  return { id, name: id, description: '', icon: 'robot', color: '#8b5cf6', systemPrompt: '认真分析问题', executor: 'codex', model: connection.model, connectionId: connection.id, skills: [{ name: '审查', content: '检查边界条件' }], mcpServers: [], updatedAt: '2026-01-01' }
}
function clone<T>(data: T): T { return JSON.parse(JSON.stringify(data)) as T }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
function snapshot() {
  return clone({ roles: studio.roles.value, draft: studio.draft.value, selectedId: studio.selectedId.value, dirty: studio.dirty.value, busy: studio.busy.value, createOpen: studio.createOpen.value, createName: studio.createName.value, createError: studio.createError.value, actionError: studio.actionError.value })
}
let stored: Role[]
let studio: ReturnType<typeof useRoleStudio>
let wrapper: VueWrapper | undefined

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
  wrapper?.unmount()
  wrapper = undefined
  finishConfirmation(false)
  toasts.value = []
  vi.restoreAllMocks()
})
async function setup(path = '/roles') {
  const Editor = defineComponent({ setup() { studio = useRoleStudio(); return () => null } })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/roles', component: Editor }, { path: '/elsewhere', component: { template: '<div />' } }] })
  await router.push(path)
  wrapper = mount(RouterView, { global: { plugins: [router] } })
  await flushPromises()
  return router
}

describe('角色工作室异步操作生命周期', () => {
  for (const action of ['create', 'copy', 'remove', 'save'] as const) {
    it.each(['resolve', 'reject'] as const)(`${action} 卸载后 %s 不改写状态、其他域路由或通知`, async (outcome) => {
      const router = await setup('/roles?id=role-a')
      const pending = deferred<Role>()
      if (action === 'create' || action === 'copy') vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise)
      if (action === 'save') vi.mocked(api.put).mockReturnValueOnce(pending.promise)
      if (action === 'remove') vi.mocked(api.delete).mockReturnValueOnce(pending.promise.then(() => undefined))
      if (action === 'create') { await studio.openCreate(); studio.createName.value = '新角色' }
      if (action === 'save') studio.draft.value!.name = '修改名称'
      const operation = studio[action]()
      if (action === 'remove') { finishConfirmation(true); await flushPromises() }
      expect(studio.busy.value).toBe(true)
      const leaving = router.push('/elsewhere?section=keep')
      await flushPromises()
      if (confirmation.value) finishConfirmation(true)
      await leaving
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/elsewhere?section=keep')
      const state = snapshot()
      const replace = vi.spyOn(router, 'replace')
      if (outcome === 'resolve') pending.resolve(makeRole('late-role'))
      else pending.reject(new Error('迟到的错误'))
      await operation
      await flushPromises()
      expect(replace).not.toHaveBeenCalled()
      expect(router.currentRoute.value.fullPath).toBe('/elsewhere?section=keep')
      expect(snapshot()).toEqual(state)
      expect(toasts.value).toEqual([])
    })
  }

  it.each(['remove', 'openCreate', 'closeCreate', 'discard'] as const)('%s 确认期间卸载后不再继续操作', async (action) => {
    await setup('/roles?id=role-a')
    if (action === 'closeCreate') { await studio.openCreate(); studio.createName.value = '待创建' }
    else studio.draft.value!.name = '未保存'
    const operation = studio[action]()
    expect(confirmation.value).not.toBeNull()
    wrapper!.unmount()
    wrapper = undefined
    const state = snapshot()
    finishConfirmation(true)
    await operation
    expect(api.delete).not.toHaveBeenCalled()
    expect(snapshot()).toEqual(state)
    expect(toasts.value).toEqual([])
  })

  it.each(['create', 'copy'] as const)('%s 正常完成后选择返回的角色并显示成功通知', async (action) => {
    const router = await setup('/roles?id=role-a')
    const role = makeRole('new-role')
    vi.spyOn(api, 'post').mockImplementationOnce(async () => { stored.push(role); return clone(role) })
    if (action === 'create') { await studio.openCreate(); studio.createName.value = '新角色' }
    await studio[action]()
    await flushPromises()
    expect(router.currentRoute.value.query.id).toBe(role.id)
    expect(studio.selectedId.value).toBe(role.id)
    expect(studio.busy.value).toBe(false)
    expect(toasts.value).toHaveLength(1)
  })

  it('角色导航仍在等待时卸载，导航结束后不弹出迟到通知', async () => {
    const router = await setup('/roles?id=role-a')
    vi.spyOn(api, 'post').mockResolvedValueOnce(makeRole('copy-role'))
    const navigation = deferred<undefined>()
    vi.spyOn(router, 'replace').mockReturnValueOnce(navigation.promise)
    const operation = studio.copy()
    await flushPromises()
    await router.push('/elsewhere')
    await flushPromises()
    navigation.resolve(undefined)
    await operation
    expect(toasts.value).toEqual([])
  })
})

describe('角色工作室草稿与导航', () => {
  it('读取深链接角色，编辑技能不会提前改写列表或持久化记录，保存后重新读取一致', async () => {
    const router = await setup('/roles?id=role-b')
    expect(studio.selectedId.value).toBe('role-b')
    studio.draft.value!.skills[0]!.content = '新增审查规则'
    expect(studio.dirty.value).toBe(true)
    expect(studio.roles.value[1]!.skills[0]!.content).toBe('检查边界条件')
    expect(stored[1]!.skills[0]!.content).toBe('检查边界条件')
    await studio.save()
    expect(studio.dirty.value).toBe(false)
    expect(stored[1]!.skills[0]!.content).toBe('新增审查规则')
    expect(toasts.value.map(toast => toast.message)).toEqual(['角色配置已保存'])
    await router.replace('/roles?id=role-a')
    await flushPromises()
    await router.replace('/roles?id=role-b')
    await flushPromises()
    expect(studio.draft.value!.skills[0]!.content).toBe('新增审查规则')
  })

  it('取消角色切换保留草稿，确认后才加载另一个角色', async () => {
    await setup()
    studio.draft.value!.name = '尚未保存'
    const cancelled = studio.selectRole('role-b')
    await flushPromises()
    expect(confirmation.value?.title).toContain('未保存')
    finishConfirmation(false)
    await cancelled
    expect(studio.draft.value!.name).toBe('尚未保存')
    const accepted = studio.selectRole('role-b')
    await flushPromises()
    finishConfirmation(true)
    await accepted
    await flushPromises()
    expect(studio.draft.value!.id).toBe('role-b')
    expect(studio.dirty.value).toBe(false)
  })

  it('保存失败保留草稿，字段校验定位对应标签页', async () => {
    await setup()
    studio.draft.value!.systemPrompt = ''
    await studio.save()
    expect(studio.tab.value).toBe('prompt')
    expect(api.put).not.toHaveBeenCalled()
    studio.draft.value!.systemPrompt = '新的提示词'
    vi.mocked(api.put).mockRejectedValueOnce(new Error('保存失败，请重试'))
    await studio.save()
    expect(studio.actionError.value).toContain('保存失败')
    expect(studio.draft.value!.systemPrompt).toBe('新的提示词')
    expect(studio.dirty.value).toBe(true)
  })

  it('删除最后一个深链接角色后清空编辑器，不重新请求已删除的详情', async () => {
    stored = [makeRole('role-a')]
    const router = await setup('/roles?id=role-a')
    vi.mocked(api.get).mockClear()
    const removing = studio.remove()
    await flushPromises()
    finishConfirmation(true)
    await removing
    await flushPromises()
    expect(studio.roles.value).toEqual([])
    expect(studio.draft.value).toBeNull()
    expect(studio.detailError.value).toBe('')
    expect(router.currentRoute.value.query.id).toBeUndefined()
    expect(toasts.value.map(toast => toast.message)).toEqual(['角色已删除'])
    expect(api.get).not.toHaveBeenCalledWith('/roles/role-a', expect.anything())
  })

  it('被引用的角色删除失败，当前定义和草稿保留', async () => {
    await setup()
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('角色仍被流程引用，请先调整流程。'))
    studio.draft.value!.name = '未保存的名称'
    const removing = studio.remove()
    await flushPromises()
    finishConfirmation(true)
    await removing
    expect(studio.actionError.value).toContain('被流程引用')
    expect(studio.draft.value!.name).toBe('未保存的名称')
    expect(studio.roles.value).toHaveLength(2)
  })
})
