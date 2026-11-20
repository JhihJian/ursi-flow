import { useState, type FormEvent } from 'react'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { addServer, listResources, listServers, removeServer, type McpServer } from '@/shared/api/work-items'

function ServerResources({ id }: { id: string }) {
  const result = useResource(signal => listResources(id, signal), [])
  return <div><ResourceState loading={result.loading} error={result.error} onRetry={result.reload} empty={!result.data.length} title={result.error ? undefined : '此服务暂无资源'} />
    <ul className="space-y-2">{result.data.map(r => <li key={r.uri} className="break-all"><strong>{r.name}</strong> · {r.uri}</li>)}</ul></div>
}
export function McpServers() {
  const servers = useResource(listServers, [])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('')
  const [view, setView] = useState<McpServer | null>(null)
  const [deleting, setDeleting] = useState<McpServer | null>(null)
  const creation = useMutation()
  const deletion = useMutation()
  function submit(e: FormEvent) {
    e.preventDefault()
    void creation.run(signal => addServer({ name: name.trim(), url: url.trim(), ...(env.trim() && { credentialEnv: env.trim() }) }, signal), () => {
      setName(''); setUrl(''); setEnv(''); servers.reload()
    })
  }
  return <div className="page-stack">
    <PageHeader title="平台 MCP 服务" />
    <form onSubmit={submit} className="border-b border-line pb-5"><fieldset disabled={creation.busy} className="grid max-w-3xl gap-3 text-sm sm:grid-cols-2">
      <legend className="mb-3 font-semibold">登记服务</legend>
      <label>服务名称<Input required value={name} onChange={e => setName(e.target.value)} /></label>
      <label>服务地址<Input type="url" required value={url} onChange={e => setUrl(e.target.value)} /></label>
      <label>凭据环境变量名（可选）<Input autoComplete="off" value={env} onChange={e => setEnv(e.target.value)} /></label>
      <div className="self-end"><Button type="submit" variant="primary" disabled={!name.trim() || !url.trim()} loading={creation.busy}>添加服务</Button></div>
      {creation.error && <p role="alert" className="text-err">{creation.error}</p>}
    </fieldset></form>
    <section><h2 className="mb-3 font-semibold">已登记服务</h2>
      <ResourceState loading={servers.loading} error={servers.error} onRetry={servers.reload} empty={!servers.data.length} title={servers.error ? undefined : '暂无 MCP 服务'} />
      <ul className="divide-y divide-line">{servers.data.map(s => <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
        <div className="min-w-0 flex-auto break-all"><strong>{s.name}</strong><p className="text-sm text-txt2">{s.id} · {s.url}</p>{s.credentialEnv && <small>凭据引用：{s.credentialEnv}</small>}</div>
        <Button onClick={() => setView(s)}>查看资源</Button><Button variant="danger" onClick={() => setDeleting(s)}>删除服务</Button>
      </li>)}</ul>
    </section>
    <Modal open={!!view} title={`${view?.name ?? ''}的资源`} onClose={() => setView(null)}>{view && <ServerResources key={view.id} id={view.id} />}</Modal>
    <Modal open={!!deleting} title="删除 MCP 服务" onClose={() => { if (!deletion.busy) setDeleting(null) }} footer={<>
      <Button disabled={deletion.busy} onClick={() => setDeleting(null)}>取消</Button>
      <Button variant="danger" loading={deletion.busy} onClick={() => deleting && void deletion.run(signal => removeServer(deleting.id, signal), () => { setDeleting(null); servers.reload() })}>确认删除</Button></>}>
      <p>确认移除「{deleting?.name}」？引用此服务的配方将无法读取资源。</p>
      {deletion.error && <p role="alert" className="text-err">{deletion.error}</p>}
    </Modal>
  </div>
}
