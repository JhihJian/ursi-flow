import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { requestV2 } from '@/shared/http/client'
import { errorMessage } from '@/shared/api'
import { Button } from '@/shared/ui/button'
import { ResourceState } from '@/shared/ui/resource-state'
import { TabBar } from '@/shared/ui/tabs'
import { Handling } from './Handling'
import { AttemptRow } from './AttemptRow'
import { DeliveryTab } from './DeliveryTab'
import { itemPath, itemStatus, post, type Attempt, type WorkItem } from './model'

const tabs = [{ id: 'handling', label: '办理' }, { id: 'attempts', label: '执行记录' }, { id: 'deliveries', label: '交付与验收' }]
export function WorkDetail() {
  const { id, version } = useParams()
  return <Detail key={id} base={itemPath(id!)} version={version} />
}
function Detail({ base, version }: { base: string; version?: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [item, setItem] = useState<WorkItem | null>(null)
  const [readError, setReadError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [choice, setChoice] = useState<{ key: string; tab: string }>()
  const [expanded, setExpanded] = useState('')
  const lock = useRef(false)
  const read = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const busy = loading || saving || !!readError
  const reload = useCallback(async () => {
    if (!mounted.current) return
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    setLoading(true); setReadError('')
    try {
      const result = await requestV2<WorkItem>(base, { signal: controller.signal })
      if (!controller.signal.aborted) setItem(result)
    } catch (cause) {
      if (!controller.signal.aborted) setReadError(errorMessage(cause))
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }, [base])
  useEffect(() => {
    mounted.current = true
    // 首次挂载立即读取当前路由对应的单据。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
    return () => { mounted.current = false; read.current?.abort() }
  }, [reload])
  const select = (tab: string) => setChoice({ key: location.key, tab })
  const inspect = (id: string) => { setExpanded(id); select('attempts') }
  const updateAttempt = useCallback((a: Attempt) => setItem(prev => prev && ({ ...prev,
    attempts: prev.attempts.some(t => t.id === a.id) ? prev.attempts.map(t => t.id === a.id ? a : t) : [...prev.attempts, a],
  })), [])

  // Refresh on a conflict before enabling any further writes. Never replay the POST.
  async function write(operation: () => Promise<void>) {
    if (lock.current || busy) return false
    lock.current = true; setSaving(true); setNotice('')
    try { await operation(); return true }
    catch (cause) {
      const conflict = cause != null && typeof cause === 'object' && 'status' in cause && cause.status === 409
      setNotice(`${conflict ? '状态冲突，正在重新读取工作项。' : ''}${errorMessage(cause)}`)
      if (conflict) await reload()
      return false
    } finally { lock.current = false; setSaving(false) }
  }
  function execute(action: string) {
    void write(async () => {
      const path = `${base}/attempts`
      let a: Attempt
      try { a = await post<Attempt>(path, { action }) }
      catch (cause) {
        if (!mounted.current) return
        select('attempts')
        try {
          const history = await requestV2<Attempt[]>(path)
          setItem(prev => prev && { ...prev, attempts: history })
          setExpanded(history.at(-1)?.id ?? '')
        } catch { await reload() }
        if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 409) await reload()
        throw new Error(`启动结果请核对本单执行记录，未自动重试。${errorMessage(cause)}`)
      }
      updateAttempt(a); inspect(a.id)
    })
  }
  const selected = choice?.key === location.key ? choice.tab : version !== undefined || item?.status === 'review' || item?.status === 'delivered' ? 'deliveries' : 'handling'
  const listStatus = new URLSearchParams(location.search).get('status')
  return <div className="page-stack break-words">
    <header className="toolbar"><div className="min-w-0"><h1 className="break-all text-xl font-semibold">{item ? `${item.package} v${item.revision}` : '工作项详情'}</h1>
      {item && <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-txt2"><span>单号：{item.id}</span><span>经办人：{item.assignee || '未指定'}</span><strong>工作项状态：{itemStatus[item.status]}</strong></p>}</div>
      <div className="flex flex-wrap gap-2"><Button asChild><Link to={`/items${listStatus ? `?${new URLSearchParams({ status: listStatus })}` : ''}`}>返回派工记录</Link></Button><Button disabled={loading || saving} icon="refresh" onClick={() => void reload()}>刷新</Button></div>
    </header>
    <ResourceState loading={!item && loading} error={readError} onRetry={reload} />
    {notice && <p role="alert" className="text-err">{notice}</p>}
    {item && <><TabBar tabs={tabs} ariaLabel="工作项详情" value={selected} onValueChange={select} />
      <div role="tabpanel" aria-label="办理" hidden={selected !== 'handling'}><Handling item={item} visible={selected === 'handling'} busy={busy} execute={execute} start={assignee => void write(async () => setItem(await post<WorkItem>(`${base}/start`, { assignee })))} /></div>
      <div role="tabpanel" aria-label="执行记录" hidden={selected !== 'attempts'}>
        {item.attempts.length === 0 && <p>暂无执行记录</p>}
        {item.attempts.map(a => <AttemptRow key={a.id} visible={selected === 'attempts'} base={base} attempt={a} open={expanded === a.id} toggle={() => setExpanded(expanded === a.id ? '' : a.id)} busy={busy} update={updateAttempt} write={async op => { await write(op) }} />)}
      </div>
      <div role="tabpanel" aria-label="交付与验收" hidden={selected !== 'deliveries'}><DeliveryTab item={item} visible={selected === 'deliveries'} base={base} version={version} busy={busy} inspect={inspect}
        deliver={(files, attemptIds) => write(async () => { setItem(await post<WorkItem>(`${base}/deliveries`, { files, attemptIds })); select('deliveries') })}
        review={(v, decision, reviewer, comment) => write(async () => {
          select('deliveries')
          const next = await post<WorkItem>(`${base}/deliveries/${v}/review`, { decision, reviewer, comment })
          if (!mounted.current) return
          setItem(next); select(next.status === 'working' ? 'handling' : 'deliveries')
          if (next.status === 'working' && version !== undefined) void navigate(`${base}${location.search}`)
        })} /></div>
    </>}
  </div>
}
