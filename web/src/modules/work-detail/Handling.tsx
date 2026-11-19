import { useState } from 'react'
import { Button } from '@/shared/ui/button'
import { lastDelivery, type WorkItem } from './model'

export function Handling({ item, busy, visible, start, execute }: {
  item: WorkItem; busy: boolean; visible: boolean; start: (assignee: string) => void; execute: (action: string) => void
}) {
  const [assignee, setAssignee] = useState('')
  const [choice, setChoice] = useState('')
  if (!visible) return null
  const snap = item.packageSnapshot
  const bindings = Object.entries(snap.actions).filter(([action]) => item.source.type !== 'connector' || item.source.action === action)
  const action = bindings.find(([name]) => name === choice)?.[0] ?? bindings[0]?.[0]
  const review = lastDelivery(item)?.review
  return <div className="space-y-5">
    {review?.decision === 'reject' && <aside className="border-l-2 border-warn pl-3"><strong>退回意见</strong><p>{review.comment}</p></aside>}
    <section className="grid gap-4 md:grid-cols-2"><div><h2 className="font-semibold">本次输入</h2><pre className="whitespace-pre-wrap break-words">{JSON.stringify(item.input, null, 2)}</pre></div>
      <div><h2 className="font-semibold">来源</h2>{item.source.type === 'builtin' ? '工作清单' : <pre className="whitespace-pre-wrap break-words">{JSON.stringify(item.source, null, 2)}</pre>}</div></section>
    <section><h2 className="font-semibold">开单时的 SOP</h2><p className="whitespace-pre-wrap">{snap.sop}</p></section>
    <section><h2 className="font-semibold">交付要求</h2><p>{snap.deliverables?.join('、') || '至少一个文本文件'}</p><p className="whitespace-pre-wrap">{snap.acceptance}</p></section>
    <section><h2 className="font-semibold">固定动作与执行器</h2><ul>{bindings.map(([name, { executor, resources }]) => <li key={name}>{name} → {executor.id} v{executor.revision}{resources.map(r => ` · ${r.id} v${r.revision}`).join('')}</li>)}</ul></section>
    {item.status === 'pending' && <form className="flex max-w-xl flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); if (assignee.trim()) start(assignee.trim()) }}>
      <label className="field flex-1">经办人<input required className="input" value={assignee} onChange={e => setAssignee(e.target.value)} /></label>
      <Button type="submit" variant="primary" disabled={busy || !assignee.trim()}>开始办理</Button></form>}
    {item.status === 'working' && <div className="max-w-xl space-y-2"><label className="field">动作<select className="select" value={action ?? ''} disabled={busy || bindings.length < 2} onChange={e => setChoice(e.target.value)}>{bindings.map(([name]) => <option key={name}>{name}</option>)}</select></label>
      {action && <p>绑定执行器：{snap.actions[action].executor.id} v{snap.actions[action].executor.revision}</p>}
      <Button variant="primary" disabled={busy || !action} onClick={() => action && execute(action)}>执行一次</Button></div>}
  </div>
}
