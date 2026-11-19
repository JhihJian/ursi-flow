import { useState } from 'react'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Select } from '@/shared/ui/select'
import {
  listSops, listTypes, sopKey, sopTitle,
  type WorkspaceSop, type WorkspaceSopRef, type WorkspaceType,
} from './model'

export interface RunControlProps {
  typeId: string
  /** 执行按钮文案，准备页和结果页共用同一套版本选择。 */
  action?: string
  running?: boolean
  disabled?: boolean
  onRun: (sop: WorkspaceSopRef) => void | Promise<void>
}

/**
 * 执行控件：读取全部已发布 SOP 版本，默认选中本类型推荐版本，允许显式换版。
 * SOP 目录读取失败只禁用执行，不影响需求编辑和材料上传。
 */
export function RunControl({ typeId, action = '执行一次', running = false, disabled = false, onRun }: RunControlProps) {
  const sops = useResource(listSops, [] as WorkspaceSop[])
  const types = useResource(listTypes, [] as WorkspaceType[])
  const [choice, setChoice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const recommended = types.data.find(type => type.id === typeId)?.sop
  const fallback = sops.data.find(sop => recommended && sopKey(sop) === sopKey(recommended)) ?? sops.data[0]
  const selected = sops.data.find(sop => sopKey(sop) === choice) ?? fallback
  const loading = sops.loading && sops.data.length === 0
  const ready = Boolean(selected) && !sops.loading && !sops.error
  const busy = running || submitting

  async function run() {
    if (!selected || !ready || disabled || busy) return
    setSubmitting(true)
    try {
      await onRun(selected)
    } catch {
      // 执行失败由调用方在页面上说明，控件只恢复可操作状态。
    } finally {
      setSubmitting(false)
    }
  }

  return <div className="space-y-3">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="field min-w-0 flex-1">
        <span className="field-label">SOP 版本</span>
        <Select aria-label="SOP 版本" value={selected ? sopKey(selected) : ''}
          disabled={!ready || busy} onChange={event => setChoice(event.target.value)}>
          {!selected && <option value="">{loading ? '正在加载已发布 SOP 版本' : '暂无可用 SOP 版本'}</option>}
          {sops.data.map(sop =>
            <option key={sopKey(sop)} value={sopKey(sop)}>{sopLabel(sop)}</option>)}
        </Select>
      </label>
      <Button variant="primary" loading={running} disabled={!ready || disabled || busy}
        onClick={() => void run()}>{action}</Button>
    </div>
    {selected && <p className="text-xs text-txt3">
      执行器 {selected.executor || '未声明'}
      {recommended && sopKey(selected) === sopKey(recommended) ? ' · 本类型推荐版本' : ''}
    </p>}
    {loading && <p className="text-xs text-txt3">正在加载已发布 SOP 版本。</p>}
    {!loading && !sops.error && sops.data.length === 0 &&
      <p className="text-sm text-warn">还没有已发布的 SOP 版本，发布后才能执行。</p>}
    {sops.error && <div className="space-y-1">
      <p role="alert" className="break-words text-sm text-err">
        SOP 版本加载失败：{sops.error} 需求编辑和材料上传不受影响。
      </p>
      <Button size="sm" onClick={sops.reload}>重新加载 SOP 版本</Button>
    </div>}
  </div>
}

function sopLabel(sop: WorkspaceSop) {
  return `${sopTitle(sop)} · ${sop.id} v${sop.revision}`
}
