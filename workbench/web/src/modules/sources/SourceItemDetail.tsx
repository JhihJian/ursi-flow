import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError } from '@/shared/http/client'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { dispatchSource, readSourceItem, sourceFault, sourceItemsPath, sourceRequestId } from './model'

export function SourceItemDetail() {
  const { provider = '', id = '' } = useParams()
  return <SourceItemPanel key={`${provider}/${id}`} provider={provider} id={id} />
}

function SourceItemPanel({ provider, id }: { provider: string; id: string }) {
  const navigate = useNavigate()
  const result = useResource(signal => readSourceItem(provider, id, signal), null)
  const [action, setAction] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  /** 每个动作各保留一个请求标识，响应丢失后的重试只复用原标识。 */
  const requestIds = useRef(new Map<string, string>())
  const sending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const item = result.data
  const fault = result.error ? sourceFault(result.error) : null
  const missing = fault === 'unconfigured'
  const selected = item && item.actions.includes(action) ? action : ''

  async function dispatch() {
    if (!item || !selected || sending.current) return
    const chosen = selected
    let requestId = requestIds.current.get(chosen)
    if (!requestId) {
      requestId = sourceRequestId()
      requestIds.current.set(chosen, requestId)
    }
    sending.current = true
    setBusy(true)
    setNotice('')
    try {
      const work = await dispatchSource(provider, id, requestId, chosen)
      if (!work || typeof work.id !== 'string' || !work.id.trim()) throw new Error('未收到工作项标识。')
      if (mounted.current) navigate(`/items/${encodeURIComponent(work.id)}`)
    } catch (cause) {
      rejectDispatch(cause, chosen)
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  /** 冲突与条目移除必须重新核对材料；只有响应丢失或服务端故障才沿用原标识重试。 */
  function rejectDispatch(cause: unknown, chosen: string) {
    const status = cause instanceof ApiError ? cause.status : null
    if (status === 401) return
    if (status === 404) {
      requestIds.current.delete(chosen)
      setAction('')
      setNotice('该条目已不在当前导出中，无法派工。已重新读取来源；已派出的单据仍保留当时的材料。')
      result.reload()
      return
    }
    if (status === 409) {
      requestIds.current.delete(chosen)
      setAction('')
      setNotice('服务端材料或动作配置已变化，本次未创建单据。已重新读取条目，请核对材料与动作后重新派工。')
      result.reload()
      return
    }
    if (status === 400) {
      requestIds.current.delete(chosen)
      setAction('')
      setNotice('服务端拒绝了该动作，本次未创建单据。已重新读取条目，请核对来源开放的动作。')
      result.reload()
      return
    }
    if (status === 503) {
      setNotice('来源导出当前不可用，本次未创建单据。可稍后重试，重试沿用同一请求标识，不会重复建单。')
      return
    }
    setNotice('派工请求未收到确认，单据可能已创建。请用同一条目动作重试，重试沿用同一请求标识，不会重复建单。')
  }

  const header = <PageHeader title="来源条目详情" description={provider} actions={<>
    <Button asChild><Link to={sourceItemsPath(provider)}>返回条目</Link></Button>
    <Button icon="refresh" onClick={result.reload} disabled={result.loading}>刷新</Button>
  </>} />

  if (result.error) {
    return <div className="page-stack break-words">
      {header}
      {missing
        ? <section className="panel space-y-3 p-6" role="status">
          <h2 className="font-semibold">条目已不可用</h2>
          <p className="text-sm text-txt2">它已从当前导出中移除，或来源已不在配置中。已派出的单据仍保留当时的材料，可在工作清单查看。</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button icon="refresh" onClick={result.reload}>重新读取</Button>
            <Link className="text-accent-2 hover:underline" to={sourceItemsPath(provider)}>返回条目列表</Link>
          </div>
        </section>
        : <ResourceState error="来源条目暂时不可用。" title="暂时无法读取来源条目" description="服务端无法读取该来源的导出文件，或网络中断。请稍后重新读取。" onRetry={result.reload} />}
    </div>
  }

  if (!item) {
    return <div className="page-stack break-words">
      {header}
      <ResourceState loading={result.loading} />
    </div>
  }

  return <div className="page-stack break-words">
    {header}
    <article className="panel space-y-5 p-4 sm:p-5">
      <div>
        <h2 className="break-words text-lg font-semibold">{item.title}</h2>
        <p className="mt-1 break-all text-sm text-txt3">{item.id}</p>
      </div>
      <div>
        <h3 className="field-label">条目材料</h3>
        <p className="mt-1 text-xs text-txt3">由管理员导出，只读。刷新会重新读取当前导出。</p>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-base p-3 text-sm">{JSON.stringify(item.input, null, 2)}</pre>
      </div>
      {item.actions.length === 0
        ? <p className="text-sm text-txt2">该来源未开放固定动作，暂不能派工。</p>
        : <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="field"><span className="field-label">固定动作</span>
            <Select aria-label="固定动作" value={selected} disabled={busy} onChange={event => { setAction(event.target.value); setNotice('') }}>
              <option value="">请选择动作</option>
              {item.actions.map(name => <option key={name} value={name}>{name}</option>)}
            </Select>
          </label>
          <Button variant="primary" loading={busy} disabled={!selected} onClick={() => void dispatch()}>派工</Button>
        </div>}
      {notice && <p role="alert" className="break-words text-sm text-err">{notice}</p>}
      <p className="text-xs text-txt3">派工按管理员配置的派工模板与动作创建待办理单据，模板、版本和执行器不在页面选择。</p>
    </article>
  </div>
}
