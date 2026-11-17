import { computed, onScopeDispose, ref, watch } from 'vue'
import { onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { api, errorMessage } from '@/shared/api'
import type { Connection, Role } from '@/shared/api/types'
import { useResource } from '@/shared/composables/useResource'
import { confirmAction, notify } from '@/shared/composables/feedback'
import { useUnsavedChanges } from '@/shared/composables/useUnsavedChanges'

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

export function useRoleStudio() {
  const route = useRoute()
  const router = useRouter()
  const rolesResource = useResource((signal) => api.get<Role[]>('/roles', signal), [])
  const connectionsResource = useResource((signal) => api.get<Connection[]>('/connections', signal), [])
  const roles = rolesResource.data
  const connections = connectionsResource.data
  const search = ref('')
  const filtered = computed(() => roles.value.filter((role) => `${role.name} ${role.description} ${role.model}`.toLowerCase().includes(search.value.trim().toLowerCase())))
  const draft = ref<Role | null>(null)
  const baseline = ref('')
  const selectedId = ref('')
  const detailLoading = ref(false)
  const detailError = ref('')
  const actionError = ref('')
  const saving = ref(false)
  const copying = ref(false)
  const deleting = ref(false)
  const tab = ref('basic')
  const createOpen = ref(false)
  const createName = ref('')
  const createError = ref('')
  const creating = ref(false)
  const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== baseline.value)
  const busy = computed(() => saving.value || copying.value || deleting.value || creating.value)
  const { canLeave } = useUnsavedChanges(() => dirty.value || (createOpen.value && !!createName.value.trim()))
  let controller: AbortController | undefined
  let generation = 0
  let active = true

  async function loadDetail(id = selectedId.value) {
    if (!active || !id) return
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    selectedId.value = id
    detailLoading.value = true
    detailError.value = ''
    actionError.value = ''
    draft.value = null
    baseline.value = ''
    try {
      const role = await api.get<Role>(`/roles/${encodeURIComponent(id)}`, controller.signal)
      if (current !== generation) return
      draft.value = clone(role)
      baseline.value = JSON.stringify(draft.value)
    } catch (cause) {
      if (current === generation && !controller.signal.aborted) detailError.value = errorMessage(cause)
    } finally { if (current === generation) detailLoading.value = false }
  }
  onScopeDispose(() => { active = false; generation++; controller?.abort() })
  onBeforeRouteUpdate(async (to, from) => {
    if (to.query.id === from.query.id) return true
    if (busy.value) return false
    return canLeave()
  })
  watch([rolesResource.loading, () => route.query.id], () => {
    if (rolesResource.loading.value || rolesResource.error.value || busy.value) return
    const id = typeof route.query.id === 'string' ? route.query.id : roles.value[0]?.id
    if (id && id !== selectedId.value) void loadDetail(id)
  }, { immediate: true })

  async function selectRole(id: string) {
    if (!active || busy.value || id === selectedId.value) return
    await router.replace({ query: { ...route.query, id } })
  }
  async function openCreate() {
    if (!active || busy.value || !await canLeave() || !active) return
    if (baseline.value) draft.value = JSON.parse(baseline.value) as Role
    createName.value = ''
    createError.value = ''
    createOpen.value = true
  }
  async function closeCreate() {
    if (!active || creating.value) return
    if (createName.value.trim() && !await confirmAction({ title: '放弃创建角色？', description: '已输入的角色名称将不会保存。', danger: true, confirmLabel: '放弃创建' })) return
    if (!active) return
    createOpen.value = false
  }
  async function create() {
    if (!active || !createName.value.trim() || creating.value) return
    createError.value = ''
    const connection = connections.value[0]
    if (!connection || connectionsResource.error.value) { createError.value = '请先创建可用的模型连接，再创建角色。'; return }
    creating.value = true
    try {
      const name = createName.value.trim()
      const role = await api.post<Role>('/roles', { name, description: '', icon: 'robot', color: '#8b5cf6', systemPrompt: `你是${name}。请围绕用户目标开展工作，提供清晰、准确、可执行的结果。`, executor: 'claude-code', connectionId: connection.id, model: connection.model, skills: [], mcpServers: [] })
      if (!active) return
      roles.value = [...roles.value, role]
      createOpen.value = false
      creating.value = false
      search.value = ''
      tab.value = 'basic'
      await router.replace({ query: { ...route.query, id: role.id } })
      if (active) notify('角色已创建，可以继续完善配置')
    } catch (cause) { if (active) createError.value = errorMessage(cause) }
    finally { if (active) creating.value = false }
  }
  function changeConnection() {
    if (!draft.value) return
    draft.value.model = connections.value.find((connection) => connection.id === draft.value?.connectionId)?.model ?? ''
  }
  function validate(role: Role): string {
    if (!role.name.trim()) { tab.value = 'basic'; return '请填写角色名称。' }
    if (!role.executor.trim()) { tab.value = 'basic'; return '请选择执行器。' }
    if (!role.systemPrompt.trim()) { tab.value = 'prompt'; return '请填写系统提示词。' }
    if (!role.connectionId || !role.model.trim()) { tab.value = 'basic'; return '请选择模型连接并填写模型名称。' }
    if (!connections.value.some((connection) => connection.id === role.connectionId)) { tab.value = 'basic'; return '所选模型连接已不存在，请刷新连接列表后重新选择。' }
    const names = new Set<string>()
    for (const skill of role.skills) {
      if (!skill.name.trim() || !skill.content.trim()) { tab.value = 'skills'; return '每个 Skill 都需要名称和技能内容。' }
      if (names.has(skill.name.trim())) { tab.value = 'skills'; return 'Skill 名称不能重复。' }
      names.add(skill.name.trim())
    }
    names.clear()
    for (const server of role.mcpServers) {
      if (!server.name.trim()) { tab.value = 'mcp'; return '请填写每个 MCP 服务的名称。' }
      if (names.has(server.name.trim())) { tab.value = 'mcp'; return 'MCP 服务名称不能重复。' }
      names.add(server.name.trim())
      if (server.transport === 'stdio' && !server.command?.trim()) { tab.value = 'mcp'; return `请填写 ${server.name} 的启动命令。` }
      if (server.transport === 'http') {
        try {
          const url = new URL(server.url ?? '')
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
        } catch { tab.value = 'mcp'; return `请为 ${server.name} 填写有效的 HTTP(S) 地址，地址中不能包含认证信息、查询参数或片段。` }
      }
    }
    return ''
  }
  async function save() {
    if (!active || !draft.value || busy.value) return
    actionError.value = validate(draft.value)
    if (actionError.value) return
    saving.value = true
    const payload = clone(draft.value)
    payload.name = payload.name.trim()
    payload.model = payload.model.trim()
    payload.skills = payload.skills.map((skill) => ({ ...skill, name: skill.name.trim() }))
    payload.mcpServers = payload.mcpServers.map((server) => ({ name: server.name.trim(), transport: server.transport, credentialRef: server.credentialRef?.trim() || '', ...(server.transport === 'http' ? { url: server.url?.trim() } : { command: server.command?.trim() }) }))
    try {
      const role = await api.put<Role>(`/roles/${encodeURIComponent(payload.id)}`, payload)
      if (!active) return
      roles.value = roles.value.map((item) => item.id === role.id ? role : item)
      draft.value = clone(role)
      baseline.value = JSON.stringify(draft.value)
      notify('角色配置已保存')
    } catch (cause) { if (active) actionError.value = errorMessage(cause) }
    finally { if (active) saving.value = false }
  }
  async function discard() {
    if (active && !busy.value && await canLeave() && active) { draft.value = JSON.parse(baseline.value) as Role; actionError.value = '' }
  }
  async function copy() {
    if (!active || !draft.value || busy.value || dirty.value) return
    copying.value = true
    actionError.value = ''
    try {
      const role = await api.post<Role>(`/roles/${encodeURIComponent(draft.value.id)}/copy`)
      if (!active) return
      roles.value = [...roles.value, role]
      copying.value = false
      search.value = ''
      await router.replace({ query: { ...route.query, id: role.id } })
      if (active) notify('已创建独立的角色副本')
    } catch (cause) { if (active) actionError.value = errorMessage(cause) }
    finally { if (active) copying.value = false }
  }
  async function remove() {
    if (!active || !draft.value || busy.value || !await confirmAction({ title: `删除「${draft.value.name}」？`, description: '角色及未保存的更改将被删除。被流程引用的角色需要先解除引用。', confirmLabel: '删除角色', danger: true }) || !active) return
    deleting.value = true
    actionError.value = ''
    try {
      const id = draft.value.id
      await api.delete(`/roles/${encodeURIComponent(id)}`)
      if (!active) return
      draft.value = null
      baseline.value = ''
      selectedId.value = ''
      roles.value = roles.value.filter((role) => role.id !== id)
      deleting.value = false
      await router.replace({ query: { ...route.query, id: roles.value[0]?.id } })
      if (active) notify('角色已删除')
    } catch (cause) { if (active) actionError.value = errorMessage(cause) }
    finally { if (active) deleting.value = false }
  }
  return { roles, connections, rolesLoading: rolesResource.loading, rolesError: rolesResource.error, reloadRoles: rolesResource.load, connectionsLoading: connectionsResource.loading, connectionsError: connectionsResource.error, reloadConnections: connectionsResource.load, search, filtered, draft, selectedId, detailLoading, detailError, actionError, tab, dirty, busy, saving, copying, deleting, createOpen, createName, createError, creating, loadDetail, selectRole, openCreate, closeCreate, create, changeConnection, save, discard, copy, remove }
}
