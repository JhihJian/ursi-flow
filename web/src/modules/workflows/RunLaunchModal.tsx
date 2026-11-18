import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { api, errorMessage } from '@/shared/api'
import type { Run, Workflow } from '@/shared/api/types'
import { useUnsavedChanges } from '@/shared/hooks/use-unsaved-changes'
import { notify } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { Textarea } from '@/shared/ui/textarea'

export interface RunLaunchModalProps {
  workflow: Workflow
  onClose: () => void
}

/** 发起运行：必填任务输入，创建成功后按响应标识进入运行详情。 */
export default function RunLaunchModal({ workflow, onClose }: RunLaunchModalProps) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const launched = useRef(false)
  const active = useRef(true)

  useEffect(() => () => { active.current = false }, [])

  const { canLeave } = useUnsavedChanges(() => !launched.current && Boolean(name || input))

  async function close() {
    if (!active.current || saving) return
    if (!await canLeave() || !active.current) return
    onClose()
  }

  async function launch() {
    if (!active.current || saving) return
    setSubmitted(true)
    setError('')
    if (!input.trim()) {
      setError('请填写任务输入，说明本次运行需要完成的工作。')
      return
    }
    setSaving(true)
    try {
      const run = await api.post<Run>('/runs', {
        workflowId: workflow.id,
        input: input.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      if (!active.current) return
      launched.current = true
      notify('运行已创建')
      onClose()
      if (active.current) await navigate(`/runs/${encodeURIComponent(run.id)}`)
    } catch (cause) {
      if (active.current) setError(errorMessage(cause))
    } finally {
      if (active.current) setSaving(false)
    }
  }

  return (
    <Modal
      open
      title="运行工作流"
      width={600}
      onClose={() => { void close() }}
      footer={(
        <>
          <Button variant="ghost" disabled={saving} onClick={() => { void close() }}>取消</Button>
          <Button type="submit" form="launch-run" variant="primary" icon="play" loading={saving}>开始运行</Button>
        </>
      )}
    >
      <form id="launch-run" className="space-y-5" noValidate onSubmit={(event) => { event.preventDefault(); void launch() }}>
        <div className="rounded-lg border border-line bg-elevated/40 px-4 py-3">
          <p className="font-medium">{workflow.name}</p>
          <p className="mt-1 text-xs text-txt3">{workflow.nodes.length} 个节点 · 创建时保存流程与角色配置快照</p>
        </div>
        <label className="field">
          <span className="field-label">运行名称 <span className="font-normal text-txt3">（可选）</span></span>
          <Input
            placeholder="留空使用默认名称"
            disabled={saving}
            value={name}
            onChange={(event) => { setName(event.target.value) }}
          />
        </label>
        <label className="field">
          <span className="field-label">任务输入 <span className="text-err">*</span></span>
          <Textarea
            rows={6}
            placeholder="描述目标、背景、输入材料和期望交付内容…"
            autoFocus
            disabled={saving}
            aria-invalid={submitted && !input.trim()}
            required
            value={input}
            onChange={(event) => { setInput(event.target.value) }}
          />
        </label>
        {error ? <p role="alert" className="text-sm text-err">{error}</p> : null}
      </form>
    </Modal>
  )
}
