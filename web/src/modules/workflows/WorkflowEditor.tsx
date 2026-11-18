import { useState } from 'react'

import { api, errorMessage } from '@/shared/api'
import type { Role, Workflow, WorkflowNode } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { useUnsavedChanges } from '@/shared/hooks/use-unsaved-changes'
import { notify } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { Select } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { parseDefinition, type WorkflowDefinition } from './definition'

export interface WorkflowEditorProps {
  workflow: Workflow | null
  onClose: () => void
  onSaved: (workflow: Workflow) => void
}

interface Draft {
  name: string
  description: string
  nodeJson: string
  edgeJson: string
}

const serialize = (draft: Draft) => JSON.stringify([draft.name, draft.description, draft.nodeJson, draft.edgeJson])

/** 新建或编辑工作流定义：JSON 校验、节点追加与未保存保护。 */
export default function WorkflowEditor({ workflow, onClose, onSaved }: WorkflowEditorProps) {
  const roles = useResource<Role[]>((signal) => api.get<Role[]>('/roles', signal), [])
  const [name, setName] = useState(workflow?.name || '')
  const [description, setDescription] = useState(workflow?.description || '')
  const [nodeJson, setNodeJson] = useState(JSON.stringify(workflow?.nodes || [], null, 2))
  const [edgeJson, setEdgeJson] = useState(JSON.stringify(workflow?.edges || [], null, 2))
  const [roleId, setRoleId] = useState('')
  const [newType, setNewType] = useState<WorkflowNode['type']>('agent')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [validation, setValidation] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [baseline, setBaseline] = useState(() => serialize({
    name: workflow?.name || '',
    description: workflow?.description || '',
    nodeJson: JSON.stringify(workflow?.nodes || [], null, 2),
    edgeJson: JSON.stringify(workflow?.edges || [], null, 2),
  }))

  const draft = { name, description, nodeJson, edgeJson }
  const dirty = serialize(draft) !== baseline
  const { canLeave } = useUnsavedChanges(() => dirty)

  async function close() {
    if (saving) return
    if (!await canLeave()) return
    onClose()
  }

  function validate(format = false): WorkflowDefinition | null {
    setError('')
    setValidation('')
    setSubmitted(true)
    if (roles.loading || roles.error) {
      setError('请先加载角色列表，再校验或保存定义。')
      return null
    }
    try {
      const definition = parseDefinition(name, description, nodeJson, edgeJson, roles.data)
      if (format) {
        setNodeJson(JSON.stringify(definition.nodes, null, 2))
        setEdgeJson(JSON.stringify(definition.edges, null, 2))
      }
      setValidation(`校验通过 · ${definition.nodes.length} 个节点，${definition.edges.length} 条连线`)
      return definition
    } catch (cause) {
      setError(errorMessage(cause))
      return null
    }
  }

  function addNode() {
    setError('')
    setValidation('')
    try {
      const nodes: unknown = JSON.parse(nodeJson)
      if (!Array.isArray(nodes)) throw new Error('节点必须为数组，请先修正节点 JSON。')
      const chosenRole = roleId || roles.data[0]?.id
      if (newType === 'agent' && !chosenRole) throw new Error('请先创建角色，或选择审批、脚本节点。')
      let index = nodes.length + 1
      while (nodes.some((node) => node?.id === `node-${index}`)) index++
      nodes.push({
        id: `node-${index}`,
        name: `节点 ${index}`,
        type: newType,
        ...(newType === 'agent' ? { roleId: chosenRole } : {}),
        ...(newType === 'script' ? { script: 'echo "Hello"' } : {}),
      })
      setNodeJson(JSON.stringify(nodes, null, 2))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  function formatJson() {
    setError('')
    setValidation('')
    try {
      const nodes: unknown = JSON.parse(nodeJson)
      const edges: unknown = JSON.parse(edgeJson)
      setNodeJson(JSON.stringify(nodes, null, 2))
      setEdgeJson(JSON.stringify(edges, null, 2))
    } catch {
      setError('JSON 格式不正确，请检查节点和连线中的括号、引号和逗号。')
    }
  }

  async function save() {
    if (saving) return
    const definition = validate()
    if (!definition) return
    setSaving(true)
    try {
      const result = workflow
        ? await api.put<Workflow>(`/workflows/${encodeURIComponent(workflow.id)}`, definition)
        : await api.post<Workflow>('/workflows', definition)
      setBaseline(serialize(draft))
      notify(workflow ? '工作流已保存' : '工作流已创建')
      onSaved(result)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={workflow ? '编辑工作流' : '新建工作流'}
      width={880}
      onClose={() => { void close() }}
      footer={(
        <>
          {dirty ? <span className="mr-auto text-xs text-txt3">有未保存的更改</span> : null}
          <Button variant="ghost" disabled={saving} onClick={() => { void close() }}>取消</Button>
          <Button
            variant="primary"
            type="submit"
            form="workflow-editor"
            loading={saving}
            disabled={roles.loading || Boolean(roles.error)}
          >
            {workflow ? '保存更改' : '创建工作流'}
          </Button>
        </>
      )}
    >
      <form id="workflow-editor" className="space-y-5" noValidate onSubmit={(event) => { event.preventDefault(); void save() }}>
        <fieldset disabled={saving} className="space-y-5">
          <label className="field">
            <span className="field-label">名称 <span className="text-err">*</span></span>
            <Input
              className="input"
              placeholder="例如：需求分析与交付"
              autoFocus
              aria-invalid={submitted && !name.trim()}
              required
              value={name}
              onChange={(event) => { setName(event.target.value) }}
            />
            {submitted && !name.trim() ? <span className="text-xs text-err">请填写工作流名称。</span> : null}
          </label>
          <label className="field">
            <span className="field-label">描述</span>
            <Textarea
              className="!min-h-[76px]"
              placeholder="说明这个流程解决什么问题"
              rows={2}
              value={description}
              onChange={(event) => { setDescription(event.target.value) }}
            />
          </label>
          <div className="rounded-lg border border-line bg-elevated/40 p-3">
            <p className="mb-3 text-xs text-txt3">添加节点后，在 JSON 中调整名称和连线。agent 引用角色，approval 等待人工审批，script 保存脚本定义。</p>
            <div className="flex flex-wrap gap-2">
              <Select
                className="!w-auto"
                aria-label="新节点类型"
                value={newType}
                onChange={(event) => { setNewType(event.target.value as WorkflowNode['type']) }}
              >
                <option value="agent">智能体</option>
                <option value="approval">人工审批</option>
                <option value="script">脚本</option>
              </Select>
              {newType === 'agent' ? (
                <Select
                  className="flex-1"
                  aria-label="新节点默认角色"
                  value={roleId}
                  disabled={roles.loading}
                  onChange={(event) => { setRoleId(event.target.value) }}
                >
                  <option value="">{roles.loading ? '正在加载角色…' : '使用第一个可用角色'}</option>
                  {roles.data.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.id}</option>)}
                </Select>
              ) : null}
              <Button variant="outline" icon="plus" onClick={addNode}>添加节点</Button>
            </div>
            {roles.error ? (
              <div className="mt-2 flex items-center gap-2 text-xs text-err" role="alert">
                {roles.error}
                <Button variant="ghost" onClick={roles.reload}>重试角色加载</Button>
              </div>
            ) : !roles.loading && !roles.data.length ? (
              <p className="mt-2 text-xs text-txt3">暂无角色。可先添加审批或脚本节点，智能体节点需先在角色页面创建角色。</p>
            ) : null}
          </div>
          <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
            <label className="field">
              <span className="field-label">节点 JSON <span className="text-err">*</span></span>
              <Textarea
                className="font-mono !text-xs"
                rows={13}
                spellCheck={false}
                aria-describedby="node-help"
                value={nodeJson}
                onChange={(event) => { setNodeJson(event.target.value); setValidation('') }}
              />
              <span id="node-help" className="text-xs text-txt3">每项包含 id、name、type。智能体填写 roleId，脚本填写 script。</span>
            </label>
            <label className="field">
              <span className="field-label">连线 JSON <span className="text-err">*</span></span>
              <Textarea
                className="font-mono !text-xs"
                rows={13}
                spellCheck={false}
                aria-describedby="edge-help"
                value={edgeJson}
                onChange={(event) => { setEdgeJson(event.target.value); setValidation('') }}
              />
              <span id="edge-help" className="text-xs text-txt3">格式：[{'{ "source": "node-1", "target": "node-2" }'}]，无连线填写 []。</span>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" icon="terminal" onClick={formatJson}>格式化 JSON</Button>
            <Button variant="ghost" icon="check" onClick={() => { validate(true) }}>校验定义</Button>
            {validation ? <span className="text-xs text-ok" role="status">{validation}</span> : null}
          </div>
        </fieldset>
        {error ? <p className="rounded-lg border border-err/20 bg-err/5 px-3 py-2 text-sm text-err" role="alert">{error}</p> : null}
      </form>
    </Modal>
  )
}
