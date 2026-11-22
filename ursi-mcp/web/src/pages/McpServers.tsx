import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation } from '../lib/use-mutation'
import { useResource } from '../lib/use-resource'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import { Input } from '../ui/input'
import { Modal } from '../ui/modal'
import { PageHeader } from '../ui/page-header'
import { ResourceState } from '../ui/resource-state'
import type { McpServer } from '../client'
import { useMcp } from '../context'
import { Select } from '../ui/select'
import { useFeedback } from '../ui/feedback'
import { ProtocolCheckButton, RecognitionBadges } from './ProtocolCheck'

const noCredentialNames = async () => [] as string[]

function RegisterDialog({ close, registered }: { close: () => void; registered: (server: McpServer) => void }) {
  const { client, listVariableNames, variableManagementPath } = useMcp()
  const formId = useId()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('')
  const variables = useResource(listVariableNames ?? noCredentialNames, [])
  const creation = useMutation()
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return
    void creation.run(signal => client.addServer({ name: name.trim(), url: url.trim(), ...(env.trim() && { credentialEnv: env.trim() }) }, signal), registered)
  }
  return <Modal open title="登记 MCP 服务" onClose={() => { if (!creation.busy) close() }} closeOnEsc={!creation.busy} closeOnBackdrop={false} footer={<>
    <Button disabled={creation.busy} onClick={close}>取消</Button>
    <Button form={formId} type="submit" variant="primary" loading={creation.busy} disabled={!name.trim() || !url.trim()}>添加服务</Button>
  </>}>
    <form id={formId} onSubmit={submit}>
      <fieldset disabled={creation.busy} className="grid gap-4 text-sm">
        <label>服务名称<Input required maxLength={240} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>服务地址<Input type="url" required maxLength={2048} placeholder="https://mcp.example.org/mcp" value={url} onChange={e => setUrl(e.target.value)} /></label>
        {listVariableNames ? <>
          <label>平台凭据（可选）<Select value={env} onChange={e => setEnv(e.target.value)}>
            <option value="">无凭据</option>
            {variables.data.map(key => <option key={key} value={key}>{key}</option>)}
          </Select></label>
          {variables.loading && <p role="status">正在读取变量名…</p>}
          {variables.error && <p role="alert">{variables.error} <Button type="button" onClick={variables.reload}>重试</Button></p>}
        </> : <label>凭据引用（可选）<Input value={env} maxLength={128} pattern="[A-Z][A-Z0-9_]*" autoComplete="off" spellCheck={false} placeholder="TEAM_TOKEN" onChange={e => setEnv(e.target.value)} /></label>}
        {variableManagementPath && <p className="text-xs leading-5 text-txt3"><Link to={variableManagementPath} className="text-accent-2 underline">管理平台变量</Link></p>}
        {env && url.trim() && <p className="break-all text-sm">连接时将把 <strong>{env}</strong> 的值作为 Bearer 令牌发送到 <strong>{url.trim()}</strong>。请确认地址可信。</p>}
        {creation.error && <p role="alert" className="text-err">{creation.error}</p>}
      </fieldset>
    </form>
  </Modal>
}

function DeleteDialog({ server, close, removed }: { server: McpServer; close: () => void; removed: () => void }) {
  const { client } = useMcp()
  const deletion = useMutation()
  return <Modal open title="删除 MCP 服务" onClose={() => { if (!deletion.busy) close() }} closeOnEsc={!deletion.busy} closeOnBackdrop={false} footer={<>
    <Button disabled={deletion.busy} onClick={close}>取消</Button>
    <Button variant="danger" loading={deletion.busy} onClick={() => void deletion.run(signal => client.removeServer(server.id, signal), removed)}>确认删除</Button>
  </>}>
    <p className="break-words text-sm">移除「{server.name}」后，引用它的配方将无法读取资源。已生成的工作包会保留。</p>
    <p className="mt-2 break-all font-mono text-xs text-txt3">{server.url}</p>
    {deletion.error && <p role="alert" className="mt-3 text-sm text-err">{deletion.error}</p>}
  </Modal>
}

const rowLayout = 'grid min-w-0 gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,.8fr)_minmax(0,13rem)] md:items-center'

export function McpServers() {
  const { client } = useMcp()
  const { notify } = useFeedback()
  const servers = useResource(client.listServers, [])
  const [search, setSearch] = useState('')
  const [registering, setRegistering] = useState(false)
  const [deleting, setDeleting] = useState<McpServer | null>(null)
  const keyword = search.trim().toLowerCase()
  const visible = servers.data.filter(s => `${s.name}\n${s.url}`.toLowerCase().includes(keyword))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.url.localeCompare(b.url))
  return <div className="page-stack">
    <PageHeader title="平台 MCP 服务" actions={<>
      <Button asChild><Link to="../mcp-recognition-rules">识别规则</Link></Button>
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
      {(servers.loading && !servers.data.length) || servers.error || !visible.length
        ? <ResourceState className="border-0 shadow-none" loading={servers.loading} error={servers.error} onRetry={servers.reload} empty={!visible.length}
          title={servers.error ? undefined : servers.data.length ? '没有匹配的服务' : '暂无服务登记'} />
        : <>
          <div aria-hidden="true" className={`${rowLayout} hidden border-b border-line bg-elevated text-xs text-txt3 md:grid`}>
            <span>服务名称</span><span>Streamable HTTP 端点</span><span>凭据引用</span><span className="min-w-[9rem] text-right">操作</span>
          </div>
          <ul className="divide-y divide-line">
            {visible.map(s => <li key={s.id} className={rowLayout}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={encodeURIComponent(s.id)} className="min-w-0 break-words text-sm font-semibold hover:text-accent-2 hover:underline">{s.name}</Link>
                  <RecognitionBadges check={s.protocolCheck} />
                </div>
                <div className="mt-1 text-xs text-txt3 md:hidden">Streamable HTTP</div>
              </div>
              <code className="min-w-0 break-all text-xs leading-5 text-txt2">{s.url}</code>
              <div className="min-w-0">
                {s.credentialEnv ? <code className="break-all text-xs text-txt2">{s.credentialEnv}</code> : <Badge variant="outline" className="whitespace-nowrap">无凭据</Badge>}
              </div>
              <div className="flex flex-wrap items-start gap-2 md:justify-end">
                <ProtocolCheckButton id={s.id} checked={servers.reload} />
                <Button asChild size="sm" icon="stage-resources"><Link to={encodeURIComponent(s.id)}>浏览资源</Link></Button>
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
