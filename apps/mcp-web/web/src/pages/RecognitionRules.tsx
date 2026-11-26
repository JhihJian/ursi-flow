import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation } from '../lib/use-mutation'
import { useResource } from '../lib/use-resource'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import { Input } from '../ui/input'
import { PageHeader } from '../ui/page-header'
import { ResourceState } from '../ui/resource-state'
import type { RecognitionRule } from '../client'
import { useMcp } from '../context'
import { useFeedback } from '../ui/feedback'

type Draft = { id: string; label: string; metaKey: string; equals: string }

const blank = (): Draft => ({ id: '', label: '', metaKey: '', equals: '' })

function normalize(drafts: Draft[]) {
  return drafts.filter(d => d.id.trim() && d.label.trim() && d.metaKey.trim() && d.equals).map(d => ({
    id: d.id.trim(), label: d.label.trim(), metaKey: d.metaKey.trim(), equals: d.equals,
  }))
}

/** 检查重复 ID 或重复规则；错误提示定位到首条冲突。 */
function conflict(drafts: Draft[]) {
  const seenId = new Set<string>()
  const seenRule = new Set<string>()
  for (let i = 0; i < drafts.length; i++) {
    const rule = normalize([drafts[i]])[0]
    if (!rule) continue
    if (seenId.has(rule.id)) return `第 ${i + 1} 条的规则 ID「${rule.id}」重复`
    if (seenRule.has(`${rule.metaKey}\n${rule.equals}`)) return `第 ${i + 1} 条与前面的规则重复`
    seenId.add(rule.id)
    seenRule.add(`${rule.metaKey}\n${rule.equals}`)
  }
  return ''
}

function RuleRow({ draft, index, count, change, remove }: {
  draft: Draft; index: number; count: number
  change: (patch: Partial<Draft>) => void; remove: () => void
}) {
  return <li className="grid items-start gap-2 border-b border-line px-4 py-3 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto]">
    <label className="text-xs text-txt3">规则 ID<Input required maxLength={64} value={draft.id} onChange={e => change({ id: e.target.value })} /></label>
    <label className="text-xs text-txt3">标签名称<Input required maxLength={64} value={draft.label} onChange={e => change({ label: e.target.value })} /></label>
    <label className="text-xs text-txt3">元数据键<Input required maxLength={128} spellCheck={false} placeholder="example/serviceKind" value={draft.metaKey} onChange={e => change({ metaKey: e.target.value })} /></label>
    <label className="text-xs text-txt3">等于值<Input required maxLength={256} spellCheck={false} placeholder="1" value={draft.equals} onChange={e => change({ equals: e.target.value })} /></label>
    <Button type="button" variant="ghost" size="icon" icon="trash" title={`删除第 ${index + 1} 条规则`} aria-label={`删除第 ${index + 1} 条规则`} disabled={count <= 1} onClick={remove} />
  </li>
}

export function RecognitionRules() {
  const { client } = useMcp()
  const { notify, confirmAction } = useFeedback()
  const rules = useResource(client.listRecognitionRules, [] as RecognitionRule[])
  const formId = useId()
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const saving = useMutation()
  const current = drafts ?? rules.data.map(({ id, label, metaKey, equals }) => ({ id, label, metaKey, equals }))
  const problem = conflict(current)
  const change = (index: number, patch: Partial<Draft>) => {
    setDrafts(prev => {
      const base = prev ?? rules.data.map(({ id, label, metaKey, equals }) => ({ id, label, metaKey, equals }))
      return base.map((draft, i) => i === index ? { ...draft, ...patch } : draft)
    })
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    const next = normalize(current)
    if (problem) return
    const message = rules.data.length
      ? `保存后按新规则重新检查协议，现有协议检查结果将全部清除。确认保存 ${next.length} 条规则？`
      : `当前没有保存过任何规则，保存 ${next.length} 条后所有服务都没有识别标签，且现有协议检查结果将清除。确认保存？`
    void confirmAction({ title: '保存识别规则', description: message, confirmLabel: '保存规则' }).then(ok => {
      if (!ok) return
      void saving.run(signal => client.saveRecognitionRules(next, signal), saved => {
        setDrafts(null)
        rules.reload()
        notify(`已保存 ${saved.length} 条识别规则，现有协议检查结果已清除，可在服务列表重新检查`)
      })
    })
  }
  return <div className="page-stack">
    <PageHeader title="MCP 识别规则" description="每条规则在协议检查时对比服务发现元数据：元数据键存在且值严格等于设定值时，服务获得该标签。标签只描述服务，不改变调用权限。" actions={<>
      <Button asChild><Link to="../mcp-servers">返回服务列表</Link></Button>
      <Button icon="refresh" loading={rules.loading} onClick={() => { setDrafts(null); rules.reload() }}>重新读取</Button>
    </>} />
    {rules.loading && !rules.data.length
      ? <ResourceState loading error={rules.error} onRetry={rules.reload} />
      : rules.error
        ? <ResourceState error={rules.error} onRetry={rules.reload} />
        : <form id={formId} onSubmit={submit} className="panel min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Icon name="connector" size={17} className="text-accent-2" />
            <h2 className="text-sm font-semibold">识别规则</h2>
            <span className="text-xs tabular-nums text-txt3">{current.length} 条</span>
          </div>
          {drafts && <p role="status" className="border-b border-line bg-elevated px-4 py-2 text-xs text-txt2">正在编辑未保存的规则，保存前不会生效。</p>}
          <ul>
            {current.map((draft, index) => <RuleRow key={index} draft={draft} index={index} count={current.length}
              change={patch => change(index, patch)}
              remove={() => setDrafts(current.filter((_, i) => i !== index))} />)}
          </ul>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            <Button type="button" icon="plus" onClick={() => setDrafts([...current, blank()])}>添加规则</Button>
            {drafts && <Button type="button" variant="ghost" onClick={() => setDrafts(null)}>放弃修改</Button>}
            {problem && <p role="alert" className="text-sm text-err">{problem}</p>}
            <Button type="submit" variant="primary" loading={saving.busy} disabled={!!problem || !!saving.busy} className="ml-auto">保存全部规则</Button>
          </div>
          {saving.error && <p role="alert" className="border-t border-line px-4 py-3 text-sm text-err">{saving.error}</p>}
        </form>}
  </div>
}
