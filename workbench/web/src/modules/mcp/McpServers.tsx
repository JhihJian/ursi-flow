import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { addServer, listServers, removeServer, serverBrowsePath, type McpServer } from '@/shared/api/mcp'
import { notify } from '@/shared/stores/feedback'

function RegisterDialog({ close, registered }: { close: () => void; registered: (server: McpServer) => void }) {
  const formId = useId()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('')
  const creation = useMutation()
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return
    void creation.run(signal => addServer({ name: name.trim(), url: url.trim(), ...(env.trim() && { credentialEnv: env.trim() }) }, signal), registered)
  }
  return <Modal open title="登记 MCP 服务" onClose={() => { if (!creation.busy) close() }} closeOnEsc={!creation.busy} closeOnBackdrop={false} footer={<>
    <Button disabled={creation.busy} onClick={close}>取消</Button>
    <Button form={formId} type="submit" variant="primary" loading={creation.busy} disabled={!name.trim() || !url.trim()}>添加服务</Button>
  </>}>
    <form id={formId} onSubmit={submit}>
      <fieldset disabled={creation.busy} className="grid gap-4 text-sm">
        <label>服务名称<Input required maxLength={240} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>服务地址<Input type="url" required maxLength={2048} placeholder="https://mcp.example.org/mcp" value={url} onChange={e => setUrl(e.target.value)} /></label>
        <label>凭据环境变量名（可选）<Input autoComplete="off" spellCheck={false} pattern="[A-Z][A-Z0-9_]*" maxLength={128} placeholder="MCP_READ_TOKEN" value={env} onChange={e => setEnv(e.target.value)} /></label>
        <p className="text-xs leading-5 text-txt3">地址与变量名由管理员授权。令牌值保留在服务端。</p>
        {creation.error && <p role="alert" className="text-err">{creation.error}</p>}
      </fieldset>
    </form>
  </Modal>
}

function DeleteDialog({ server, close, removed }: { server: McpServer; close: () => void; removed: () => void }) {
  const deletion = useMutation()
  return <Modal open title="删除 MCP 服务" onClose={() => { if (!deletion.busy) close() }} closeOnEsc={!deletion.busy} closeOnBackdrop={false} footer={<>
    <Button disabled={deletion.busy} onClick={close}>取消</Button>
    <Button variant="danger" loading={deletion.busy} onClick={() => void deletion.run(signal => removeServer(server.id, signal), removed)}>确认删除</Button>
  </>}>
    <p className="break-words text-sm">移除「{server.name}」后，引用它的配方将无法读取资源。已生成的工作包会保留。</p>
    <p className="mt-2 break-all font-mono text-xs text-txt3">{server.url}</p>
    {deletion.error && <p role="alert" className="mt-3 text-sm text-err">{deletion.error}</p>}
  </Modal>
}

const rowLayout = 'grid min-w-0 gap-3 px-4 py-3 md:grid-cols-[minmax(9rem,1fr)_minmax(12rem,1.6fr)_minmax(7rem,.8fr)_auto] md:items-center'

export function McpServers() {
  const servers = useResource(listServers, [])
  const [search, setSearch] = useState('')
  const [registering, setRegistering] = useState(false)
  const [deleting, setDeleting] = useState<McpServer | null>(null)
  const keyword = search.trim().toLowerCase()
  const visible = servers.data.filter(s => `${s.name}\n${s.url}`.toLowerCase().includes(keyword))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.url.localeCompare(b.url))
  return <div className="page-stack">
    <PageHeader title="平台 MCP 服务" actions={<>
      <Button icon="refresh" loading={servers.loading} onClick={servers.reload}>刷新登记</Button>
      <Button icon="plus" variant="primary" onClick={() => setRegistering(true)}>登记服务</Button>
    </>} />
    <section aria-label="服务登记" className="panel min-w-0 overflow-hidden rounded-lg">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon name="connector" size={17} className="text-accent-2" />
          <h2 className="text-sm font-semibold">服务登记</h2>
          <span role="status" className="text-xs tabular-nums text-txt3">{servers.loading ? '加载中' : servers.error ? '读取失败' : `${visible.length} / ${servers.data.length}`}</span>
        </div>
        <input type="search" aria-label="搜索服务" placeholder="搜索名称或地址" className="search-input w-full sm:w-64" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      {servers.loading || servers.error || !visible.length
        ? <ResourceState className="border-0 shadow-none" loading={servers.loading} error={servers.error} onRetry={servers.reload} empty={!visible.length}
          title={servers.error ? undefined : servers.data.length ? '没有匹配的服务' : '暂无服务登记'} />
        : <>
          <div aria-hidden="true" className={`${rowLayout} hidden border-b border-line bg-elevated text-xs text-txt3 md:grid`}>
            <span>服务名称</span><span>Streamable HTTP 端点</span><span>凭据引用</span><span className="min-w-[9rem] text-right">操作</span>
          </div>
          <ul className="divide-y divide-line">
            {visible.map(s => <li key={s.id} className={rowLayout}>
              <div className="min-w-0">
                <Link to={serverBrowsePath(s.id)} className="break-words text-sm font-semibold hover:text-accent-2 hover:underline">{s.name}</Link>
                <div className="mt-1 text-xs text-txt3 md:hidden">Streamable HTTP</div>
              </div>
              <code className="min-w-0 break-all text-xs leading-5 text-txt2">{s.url}</code>
              <div className="min-w-0">
                {s.credentialEnv ? <code className="break-all text-xs text-txt2">{s.credentialEnv}</code> : <Badge variant="outline">无凭据</Badge>}
              </div>
              <div className="flex items-center gap-2 md:justify-end">
                <Button asChild size="sm" icon="stage-resources"><Link to={serverBrowsePath(s.id)}>浏览资源</Link></Button>
                <Button variant="ghost" size="icon" icon="trash" title="删除登记" aria-label={`删除 ${s.name}`} onClick={() => setDeleting(s)} />
              </div>
            </li>)}
          </ul>
        </>}
    </section>
    {registering && <RegisterDialog close={() => setRegistering(false)} registered={server => {
      setRegistering(false); setSearch(''); servers.reload(); notify(`「${server.name}」已登记`)
    }} />}
    {deleting && <DeleteDialog server={deleting} close={() => setDeleting(null)} removed={() => {
      setDeleting(null); servers.reload(); notify('已删除服务登记')
    }} />}
  </div>
}
