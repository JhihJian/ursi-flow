import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { api, errorMessage } from '@/shared/api'
import type { Connection, McpServer, Role, Skill } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { useUnsavedChanges } from '@/shared/hooks/use-unsaved-changes'
import { confirmAction, notify } from '@/shared/stores/feedback'

export type RoleTab = 'basic' | 'prompt' | 'skills' | 'mcp'
export type RoleStudio = ReturnType<typeof useRoleStudio>

/** 写操作成功后叠加在接口列表上的本地差异，刷新列表时仍然生效。 */
interface RoleOverlay {
  removed: string[]
  changed: Role[]
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

/**
 * 角色工作室的状态与业务规则：列表、草稿、字段校验、保存归一化、
 * 复制/删除后的导航，以及未保存更改进出保护。
 */
export function useRoleStudio() {
  const rolesResource = useResource<Role[]>((signal) => api.get<Role[]>('/roles', signal), [])
  const connectionsResource = useResource<Connection[]>((signal) => api.get<Connection[]>('/connections', signal), [])
  const connections = connectionsResource.data

  const [search, setSearch] = useState('')
  const [overlay, setOverlay] = useState<RoleOverlay>({ removed: [], changed: [] })
  const roles = useMemo(() => {
    const removed = new Set(overlay.removed)
    const changed = new Map(overlay.changed.map((role) => [role.id, role]))
    const base = rolesResource.data
      .filter((role) => !removed.has(role.id))
      .map((role) => changed.get(role.id) ?? role)
    const known = new Set(base.map((role) => role.id))
    return [...base, ...overlay.changed.filter((role) => !known.has(role.id) && !removed.has(role.id))]
  }, [overlay, rolesResource.data])

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return roles
    return roles.filter((role) => `${role.name} ${role.description} ${role.model}`.toLowerCase().includes(keyword))
  }, [roles, search])

  const [draft, setDraft] = useState<Role | null>(null)
  const [baseline, setBaseline] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [actionError, setActionError] = useState('')
  const [tab, setTab] = useState<RoleTab>('basic')
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)

  const dirty = draft !== null && JSON.stringify(draft) !== baseline
  const busy = saving || copying || deleting || creating
  const { canLeave } = useUnsavedChanges(() => dirty || (createOpen && Boolean(createName.trim())))

  const activeRef = useRef(true)
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const selectedRef = useRef('')
  /** 地址栏里已处理过的 id，避免状态变动把同一次路由变化重复落到详情或确认。 */
  const handledRouteRef = useRef('')

  const location = useLocation()
  const navigate = useNavigate()
  const routeId = useMemo(() => new URLSearchParams(location.search).get('id') ?? '', [location.search])

  const markSelected = useCallback((id: string) => {
    selectedRef.current = id
    setSelectedId(id)
  }, [])

  const roleUrl = useCallback((id?: string) => {
    const next = new URLSearchParams(location.search)
    if (id) next.set('id', id)
    else next.delete('id')
    const query = next.toString()
    return query ? `${location.pathname}?${query}` : location.pathname
  }, [location.pathname, location.search])

  const loadDetail = useCallback(async (id?: string) => {
    const target = id ?? selectedRef.current
    if (!activeRef.current || !target) return
    const current = generationRef.current + 1
    generationRef.current = current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    markSelected(target)
    setDetailLoading(true)
    setDetailError('')
    setActionError('')
    setDraft(null)
    setBaseline('')
    try {
      const role = await api.get<Role>(`/roles/${encodeURIComponent(target)}`, controller.signal)
      if (current !== generationRef.current) return
      const next = clone(role)
      setDraft(next)
      setBaseline(JSON.stringify(next))
    } catch (cause) {
      if (current === generationRef.current && !controller.signal.aborted) setDetailError(errorMessage(cause))
    } finally {
      if (current === generationRef.current) setDetailLoading(false)
    }
  }, [markSelected])

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      generationRef.current += 1
      controllerRef.current?.abort()
    }
  }, [])

  // 地址栏是选中角色的唯一来源：深链接、历史导航与内部跳转都经这里落到详情。
  useEffect(() => {
    if (!routeId || handledRouteRef.current === routeId) return
    if (routeId === selectedRef.current || busy) return
    handledRouteRef.current = routeId
    void (async () => {
      if (dirty) {
        const allowed = await canLeave()
        if (!activeRef.current) return
        if (!allowed) {
          const current = selectedRef.current
          handledRouteRef.current = current
          if (current) await navigate(roleUrl(current), { replace: true })
          return
        }
      }
      await loadDetail(routeId)
    })()
  }, [busy, canLeave, dirty, loadDetail, navigate, roleUrl, routeId])

  // 未带 id 时默认选中首条记录，与深链接保持一致但不改写地址。
  useEffect(() => {
    if (routeId || selectedRef.current || busy) return
    if (rolesResource.loading || rolesResource.error) return
    const first = roles[0]
    if (first) void loadDetail(first.id)
  }, [busy, loadDetail, roles, rolesResource.error, rolesResource.loading, routeId])

  const selectRole = useCallback(async (id: string) => {
    if (!activeRef.current || busy || id === selectedRef.current) return
    await navigate(roleUrl(id), { replace: true })
  }, [busy, navigate, roleUrl])

  const openCreate = useCallback(async () => {
    if (!activeRef.current || busy) return
    if (!await canLeave()) return
    if (!activeRef.current) return
    if (baseline) setDraft(JSON.parse(baseline) as Role)
    setCreateName('')
    setCreateError('')
    setCreateOpen(true)
  }, [baseline, busy, canLeave])

  const closeCreate = useCallback(async () => {
    if (!activeRef.current || creating) return
    if (createName.trim() && !await confirmAction({ title: '放弃创建角色？', description: '已输入的角色名称将不会保存。', danger: true, confirmLabel: '放弃创建' })) return
    if (!activeRef.current) return
    setCreateOpen(false)
  }, [createName, creating])

  const create = useCallback(async () => {
    if (!activeRef.current || !createName.trim() || creating) return
    setCreateError('')
    const connection = connections[0]
    if (!connection || connectionsResource.error) {
      setCreateError('请先创建可用的模型连接，再创建角色。')
      return
    }
    setCreating(true)
    try {
      const name = createName.trim()
      const role = await api.post<Role>('/roles', {
        name,
        description: '',
        icon: 'robot',
        color: '#8b5cf6',
        systemPrompt: `你是${name}。请围绕用户目标开展工作，提供清晰、准确、可执行的结果。`,
        executor: 'claude-code',
        connectionId: connection.id,
        model: connection.model,
        skills: [],
        mcpServers: [],
      })
      if (!activeRef.current) return
      setOverlay((current) => ({ ...current, changed: [...current.changed, role] }))
      setCreateOpen(false)
      setCreating(false)
      setSearch('')
      setTab('basic')
      await navigate(roleUrl(role.id), { replace: true })
      if (activeRef.current) notify('角色已创建，可以继续完善配置')
    } catch (cause) {
      if (activeRef.current) setCreateError(errorMessage(cause))
    } finally {
      if (activeRef.current) setCreating(false)
    }
  }, [connections, connectionsResource.error, createName, creating, navigate, roleUrl])

  const updateDraft = useCallback((patch: Partial<Role>) => {
    setDraft((current) => current ? { ...current, ...patch } : current)
  }, [])

  const changeConnection = useCallback((connectionId: string) => {
    setDraft((current) => current
      ? { ...current, connectionId, model: connections.find((connection) => connection.id === connectionId)?.model ?? '' }
      : current)
  }, [connections])

  const addSkill = useCallback(() => {
    setDraft((current) => current ? { ...current, skills: [...current.skills, { name: '', content: '' }] } : current)
  }, [])

  const removeSkill = useCallback((index: number) => {
    setDraft((current) => current ? { ...current, skills: current.skills.filter((_, position) => position !== index) } : current)
  }, [])

  const updateSkill = useCallback((index: number, patch: Partial<Skill>) => {
    setDraft((current) => current
      ? { ...current, skills: current.skills.map((skill, position) => position === index ? { ...skill, ...patch } : skill) }
      : current)
  }, [])

  const addMcp = useCallback(() => {
    setDraft((current) => current
      ? { ...current, mcpServers: [...current.mcpServers, { name: '', transport: 'http', url: '', credentialRef: '' }] }
      : current)
  }, [])

  const removeMcp = useCallback((index: number) => {
    setDraft((current) => current
      ? { ...current, mcpServers: current.mcpServers.filter((_, position) => position !== index) }
      : current)
  }, [])

  const updateMcp = useCallback((index: number, patch: Partial<McpServer>) => {
    setDraft((current) => current
      ? { ...current, mcpServers: current.mcpServers.map((server, position) => position === index ? { ...server, ...patch } : server) }
      : current)
  }, [])

  const validate = useCallback((role: Role): string => {
    if (!role.name.trim()) { setTab('basic'); return '请填写角色名称。' }
    if (!role.executor.trim()) { setTab('basic'); return '请选择执行器。' }
    if (!role.systemPrompt.trim()) { setTab('prompt'); return '请填写系统提示词。' }
    if (!role.connectionId || !role.model.trim()) { setTab('basic'); return '请选择模型连接并填写模型名称。' }
    if (!connections.some((connection) => connection.id === role.connectionId)) { setTab('basic'); return '所选模型连接已不存在，请刷新连接列表后重新选择。' }
    const names = new Set<string>()
    for (const skill of role.skills) {
      if (!skill.name.trim() || !skill.content.trim()) { setTab('skills'); return '每个 Skill 都需要名称和技能内容。' }
      if (names.has(skill.name.trim())) { setTab('skills'); return 'Skill 名称不能重复。' }
      names.add(skill.name.trim())
    }
    names.clear()
    for (const server of role.mcpServers) {
      if (!server.name.trim()) { setTab('mcp'); return '请填写每个 MCP 服务的名称。' }
      if (names.has(server.name.trim())) { setTab('mcp'); return 'MCP 服务名称不能重复。' }
      names.add(server.name.trim())
      if (server.transport === 'stdio' && !server.command?.trim()) { setTab('mcp'); return `请填写 ${server.name} 的启动命令。` }
      if (server.transport === 'http') {
        try {
          const url = new URL(server.url ?? '')
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
        } catch { setTab('mcp'); return `请为 ${server.name} 填写有效的 HTTP(S) 地址，地址中不能包含认证信息、查询参数或片段。` }
      }
    }
    return ''
  }, [connections])

  const save = useCallback(async () => {
    if (!activeRef.current || !draft || busy) return
    const problem = validate(draft)
    setActionError(problem)
    if (problem) return
    setSaving(true)
    const payload = clone(draft)
    payload.name = payload.name.trim()
    payload.model = payload.model.trim()
    payload.skills = payload.skills.map((skill) => ({ ...skill, name: skill.name.trim() }))
    payload.mcpServers = payload.mcpServers.map((server) => ({
      name: server.name.trim(),
      transport: server.transport,
      credentialRef: server.credentialRef?.trim() || '',
      ...(server.transport === 'http' ? { url: server.url?.trim() } : { command: server.command?.trim() }),
    }))
    try {
      const role = await api.put<Role>(`/roles/${encodeURIComponent(payload.id)}`, payload)
      if (!activeRef.current) return
      setOverlay((current) => ({
        ...current,
        changed: current.changed.some((item) => item.id === role.id)
          ? current.changed.map((item) => item.id === role.id ? role : item)
          : [...current.changed, role],
      }))
      const next = clone(role)
      setDraft(next)
      setBaseline(JSON.stringify(next))
      notify('角色配置已保存')
    } catch (cause) {
      if (activeRef.current) setActionError(errorMessage(cause))
    } finally {
      if (activeRef.current) setSaving(false)
    }
  }, [busy, draft, validate])

  const discard = useCallback(async () => {
    if (!activeRef.current || busy) return
    if (!await canLeave()) return
    if (!activeRef.current) return
    setDraft(JSON.parse(baseline) as Role)
    setActionError('')
  }, [baseline, busy, canLeave])

  const copy = useCallback(async () => {
    if (!activeRef.current || !draft || busy || dirty) return
    setCopying(true)
    setActionError('')
    try {
      const role = await api.post<Role>(`/roles/${encodeURIComponent(draft.id)}/copy`)
      if (!activeRef.current) return
      setOverlay((current) => ({ ...current, changed: [...current.changed, role] }))
      setCopying(false)
      setSearch('')
      await navigate(roleUrl(role.id), { replace: true })
      if (activeRef.current) notify('已创建独立的角色副本')
    } catch (cause) {
      if (activeRef.current) setActionError(errorMessage(cause))
    } finally {
      if (activeRef.current) setCopying(false)
    }
  }, [busy, dirty, draft, navigate, roleUrl])

  const remove = useCallback(async () => {
    if (!activeRef.current || !draft || busy) return
    const accepted = await confirmAction({
      title: `删除「${draft.name}」？`,
      description: '角色及未保存的更改将被删除。被流程引用的角色需要先解除引用。',
      confirmLabel: '删除角色',
      danger: true,
    })
    if (!accepted || !activeRef.current) return
    setDeleting(true)
    setActionError('')
    try {
      const id = draft.id
      await api.delete(`/roles/${encodeURIComponent(id)}`)
      if (!activeRef.current) return
      setDraft(null)
      setBaseline('')
      markSelected('')
      setOverlay((current) => ({ removed: [...current.removed, id], changed: current.changed.filter((role) => role.id !== id) }))
      setDeleting(false)
      const remaining = roles.filter((role) => role.id !== id)
      await navigate(roleUrl(remaining[0]?.id), { replace: true })
      if (activeRef.current) notify('角色已删除')
    } catch (cause) {
      if (activeRef.current) setActionError(errorMessage(cause))
    } finally {
      if (activeRef.current) setDeleting(false)
    }
  }, [busy, draft, markSelected, navigate, roleUrl, roles])

  return {
    roles,
    filtered,
    connections,
    rolesLoading: rolesResource.loading,
    rolesError: rolesResource.error,
    reloadRoles: rolesResource.reload,
    connectionsLoading: connectionsResource.loading,
    connectionsError: connectionsResource.error,
    reloadConnections: connectionsResource.reload,
    search,
    setSearch,
    draft,
    selectedId,
    detailLoading,
    detailError,
    actionError,
    tab,
    setTab,
    dirty,
    busy,
    saving,
    copying,
    deleting,
    createOpen,
    createName,
    setCreateName,
    createError,
    creating,
    loadDetail,
    selectRole,
    openCreate,
    closeCreate,
    create,
    changeConnection,
    updateDraft,
    addSkill,
    removeSkill,
    updateSkill,
    addMcp,
    removeMcp,
    updateMcp,
    save,
    discard,
    copy,
    remove,
  }
}
