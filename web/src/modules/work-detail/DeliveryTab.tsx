import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { errorMessage } from '@/shared/api'
import { requestV2Text } from '@/shared/http/client'
import { useResource } from '@/shared/hooks/use-resource'
import { ResourceState } from '@/shared/ui/resource-state'
import { Button } from '@/shared/ui/button'
import { attemptStatus, lastDelivery, locked, type WorkItem, type Delivery } from './model'

type Decision = 'accept' | 'reject'
type LoadedFile = { name: string; text?: string; error?: string }

// 交付文件只应是纯文本。共享客户端负责按响应类型拒绝非文本，这里连同空响应一起按不可读处理。
const htmlPage = (text: string) => /^<(?:!doctype\s+html|html[\s>])/iu.test(text.trim())

async function readDeliveredFile(base: string, name: string, signal: AbortSignal): Promise<LoadedFile> {
  try {
    const text = await requestV2Text(`${base}/files/${encodeURIComponent(name)}`, { signal })
    if (!text.trim()) return { name, error: '响应为空，未取得正文。' }
    if (htmlPage(text)) return { name, error: '返回 HTML 页面，不是文件正文。' }
    return { name, text }
  } catch (cause) {
    if (signal.aborted) throw cause
    return { name, error: errorMessage(cause) }
  }
}
type Props = {
  item: WorkItem; base: string; version?: string; busy: boolean; visible: boolean
  inspect: (id: string) => void
  deliver: (files: Record<string, string>, attemptIds: string[]) => Promise<boolean>
  review: (version: number, decision: Decision, reviewer: string, comment: string) => Promise<boolean>
}

function VersionFiles({ path, delivery, children }: { path: string; delivery: Delivery; children: React.ReactNode }) {
  const names = Object.keys(delivery.files)
  const files = useResource(s => Promise.all(names.map(name => readDeliveredFile(path, name, s))), [] as LoadedFile[])
  const unreadable = files.data.filter(file => file.error)
  const ready = !files.loading && !files.error && files.data.length === names.length && unreadable.length === 0
  return <section className="min-w-0 space-y-3"><h3 className="font-semibold">第 {delivery.version} 版交付文件</h3>
    <ResourceState loading={files.loading} error={files.error} onRetry={files.reload} />
    {files.data.map(file => <div key={file.name}><h4 className="font-medium text-txt2">{file.name}</h4>
      {file.error
        ? <p role="alert" className="text-err">文件「{file.name}」不可读：{file.error}</p>
        : <pre className="max-h-96 whitespace-pre-wrap break-words border-l-2 border-line pl-3">{file.text}</pre>}
    </div>)}
    {unreadable.length > 0 && <div className="space-y-2 border-l-2 border-err pl-3"><p className="text-err">第 {delivery.version} 版有 {unreadable.length} 份文件未能读取，读完本版全部文件前不能验收。</p><Button size="sm" icon="refresh" onClick={files.reload}>重新读取文件</Button></div>}
    {ready && children}
  </section>
}

type DraftFile = { name: string; text: string; required: boolean }
const validName = (name: string) => name.trim() !== '' && !['.', '..'].includes(name) && !/[\\/]/u.test(name) && !Array.from(name).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
function Submission({ item, busy, inspect, deliver, writable, visible }: Pick<Props, 'item' | 'busy' | 'inspect' | 'deliver' | 'visible'> & { writable: boolean }) {
  const initialFiles = (): DraftFile[] => item.packageSnapshot.deliverables?.length ? item.packageSnapshot.deliverables.map(name => ({ name, text: '', required: true })) : [{ name: 'report.txt', text: '', required: false }]
  const [files, setFiles] = useState(initialFiles)
  const [ids, setIds] = useState<string[]>([])
  const blockers = item.attempts.filter(locked)
  const latest = lastDelivery(item)
  const rejected = latest?.review?.decision === 'reject' ? latest : undefined
  const valid = files.length > 0 && files.every(f => validName(f.name) && f.text.trim()) && new Set(files.map(f => f.name)).size === files.length
  const change = (i: number, patch: Partial<DraftFile>) => setFiles(prev => prev.map((f, j) => j === i ? { ...f, ...patch } : f))
  if (!visible || (!writable && !files.some(f => f.text))) return null
  return <section className="space-y-3 border-t border-line pt-4"><h2 className="font-semibold">{writable ? '提交新版交付' : '未提交的交付草稿（只读）'}</h2>
    {writable && rejected?.review && <aside className="border-l-2 border-warn pl-3"><strong>第 {rejected.version} 版被退回 · {rejected.review.reviewer}</strong><p className="whitespace-pre-wrap">{rejected.review.comment}</p><p className="text-txt2">按意见修改后再提交，下一版将成为第 {rejected.version + 1} 版。</p></aside>}
    {writable && blockers.length > 0 && <div className="border-l-2 border-warn pl-3"><p>以下尝试未结束或待核实，暂不能交付：</p>{blockers.map(a => <div key={a.id}><button className="text-accent-2 underline" onClick={() => inspect(a.id)}>{a.action} · {attemptStatus[a.status]} · {a.id}</button></div>)}</div>}
    <fieldset disabled={busy || !writable} className="space-y-3">
      {files.map((file, i) => <div key={i} className="space-y-1">
        {!file.required && <label className="field">文件名<input className="input" value={file.name} onChange={e => change(i, { name: e.target.value })} /></label>}
        <label className="field">文件正文：{file.name}<textarea className="textarea" value={file.text} onChange={e => change(i, { text: e.target.value })} /></label>
        {!file.required && files.length > 1 && <Button size="sm" onClick={() => setFiles(files.filter((_, j) => j !== i))}>移除文件</Button>}
      </div>)}
      {writable && <Button onClick={() => setFiles([...files, { name: '', text: '', required: false }])}>添加文件</Button>}
      {item.attempts.length > 0 && <fieldset><legend className="font-medium">关联本单尝试</legend>{item.attempts.map(a => <label key={a.id} className="flex items-baseline gap-2"><input type="checkbox" checked={ids.includes(a.id)} onChange={e => setIds(e.target.checked ? [...ids, a.id] : ids.filter(id => id !== a.id))} />{a.action} · {attemptStatus[a.status]} · {a.id}</label>)}</fieldset>}
      {writable && <Button variant="primary" disabled={!valid || blockers.length > 0} onClick={async () => {
        if (await deliver(Object.fromEntries(files.map(f => [f.name, f.text])), ids)) { setFiles(initialFiles()); setIds([]) }
      }}>提交交付</Button>}
    </fieldset>
  </section>
}

export function DeliveryTab({ item, base, version, busy, inspect, deliver, review, visible }: Props) {
  const { search } = useLocation()
  const current = lastDelivery(item)
  // Keep the inspected target on a conflict, even on the default (unversioned) route.
  const [pin, setPin] = useState<number>()
  const [drafts, setDrafts] = useState<Record<number, { reviewer: string; comment: string }>>({})
  const selected = version !== undefined ? item.deliveries.find(d => String(d.version) === version) : item.deliveries.find(d => d.version === pin) ?? current
  const n = selected?.version
  const draft = (n && drafts[n]) || { reviewer: '', comment: '' }
  const canReview = !!selected && selected === current && !selected.review && item.status === 'review'
  const writable = item.status === 'working' && version === undefined && (!selected || selected === current)
  const edit = (patch: Partial<typeof draft>) => { if (n) setDrafts({ ...drafts, [n]: { ...draft, ...patch } }) }
  async function submit(decision: Decision) {
    if (!n || !canReview || !draft.reviewer.trim() || (decision === 'reject' && !draft.comment.trim())) return
    setPin(n)
    if (await review(n, decision, draft.reviewer.trim(), draft.comment)) {
      setPin(undefined)
      setDrafts(prev => { const next = { ...prev }; delete next[n]; return next })
    }
  }
  return <div className="space-y-5">
    {visible && <>
    {item.deliveries.length > 0 && <nav aria-label="交付版本" className="flex flex-wrap gap-x-4 gap-y-2">{item.deliveries.map(d => <Link key={d.version} aria-current={n === d.version ? 'page' : undefined} className="text-accent-2 underline aria-[current=page]:font-semibold" to={`${base}/deliveries/${d.version}${search}`}>第 {d.version} 版{item.acceptedVersion === d.version ? '（已通过）' : d === current ? '（当前）' : ''}</Link>)}</nav>}
    {version !== undefined && !selected && <p role="alert">交付版本不存在。</p>}
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <section><h2 className="font-semibold">验收标准</h2><p className="whitespace-pre-wrap">{item.packageSnapshot.acceptance}</p></section>
      {selected ? <div className="min-w-0 space-y-3"><VersionFiles key={selected.version} delivery={selected} path={`${base}/deliveries/${selected.version}`}>
        {canReview && <fieldset disabled={busy} className="space-y-2 border-t border-line pt-3"><legend className="font-medium">验收第 {n} 版</legend>
          <label className="field">验收人<input className="input" value={draft.reviewer} onChange={e => edit({ reviewer: e.target.value })} /></label>
          <label className="field">验收意见<textarea className="textarea" value={draft.comment} onChange={e => edit({ comment: e.target.value })} /></label>
          <div className="flex gap-2"><Button variant="primary" disabled={!draft.reviewer.trim()} onClick={() => void submit('accept')}>通过</Button><Button disabled={!draft.reviewer.trim() || !draft.comment.trim()} onClick={() => void submit('reject')}>退回</Button></div>
        </fieldset>}
      </VersionFiles>
      {selected.attemptIds.length > 0 && <div>来源尝试：{selected.attemptIds.map(id => <button className="mr-2 text-accent-2 underline" key={id} onClick={() => inspect(id)}>{id}</button>)}</div>}
      {selected.review && <section><h3 className="font-medium">{selected.review.decision === 'accept' ? '通过' : '退回'} · {selected.review.reviewer}</h3><p className="whitespace-pre-wrap">{selected.review.comment}</p></section>}
      {!canReview && (draft.reviewer || draft.comment) && <section><h3>第 {n} 版未提交的验收草稿（只读）</h3><p>{draft.reviewer}</p><p className="whitespace-pre-wrap">{draft.comment}</p></section>}
      </div> : version === undefined && <p className="text-txt3">暂无交付版本</p>}
    </div>
    {version !== undefined && item.status === 'working' && <Link to={`${base}${search}`} className="text-accent-2 underline">返回办理</Link>}
    </>}
    <Submission item={item} busy={busy} visible={visible} inspect={inspect} deliver={async (files, ids) => { const ok = await deliver(files, ids); if (ok) setPin(undefined); return ok }} writable={writable} />
  </div>
}
