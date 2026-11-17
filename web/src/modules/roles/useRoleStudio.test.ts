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
