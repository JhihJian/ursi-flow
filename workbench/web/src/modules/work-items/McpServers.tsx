import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { addServer, listServers, removeServer, serverBrowsePath, type McpServer } from '@/shared/api/work-items'

export function McpServers() {
  const servers = useResource(listServers, [])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('')
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
    <PageHeader title="平台 MCP 服务" description="登记获准的只读服务，再进入服务浏览资源并挑选到工作项配方。" />
    <form onSubmit={submit} className="panel p-5"><fieldset disabled={creation.busy} className="grid max-w-3xl gap-3 text-sm sm:grid-cols-2">
      <legend className="mb-3 font-semibold">登记服务</legend>
      <label>服务名称<Input required value={name} onChange={e => setName(e.target.value)} /></label>
      <label>服务地址<Input type="url" required value={url} onChange={e => setUrl(e.target.value)} /></label>
      <label>凭据环境变量名（可选）<Input autoComplete="off" value={env} onChange={e => setEnv(e.target.value)} /></label>
      <div className="self-end"><Button type="submit" variant="primary" disabled={!name.trim() || !url.trim()} loading={creation.busy}>添加服务</Button></div>
      <p className="text-xs leading-6 text-txt3 sm:col-span-2">这里只填变量名，令牌值由管理员在服务进程中设置。地址必须在管理员策略中已获授权。</p>
      {creation.error && <p role="alert" className="text-err sm:col-span-2">{creation.error}</p>}
    </fieldset></form>
    <section><h2 className="mb-3 font-semibold">已登记服务</h2>
      <ResourceState loading={servers.loading} error={servers.error} onRetry={servers.reload} empty={!servers.data.length} title={servers.error ? undefined : '暂无 MCP 服务'} description={servers.error ? undefined : '登记后即可进入服务浏览其中的资源。'} />
      <ul className="grid gap-3 lg:grid-cols-2">
        {servers.data.map(s => <li key={s.id} className="panel flex min-w-0 flex-col gap-3 p-4">
          <div className="min-w-0">
            <strong className="break-all text-sm">{s.name}</strong>
            <p className="mt-1 break-all text-xs text-txt3">{s.url}</p>
            <p className="mt-1 text-xs text-txt3">{s.credentialEnv ? `凭据引用：${s.credentialEnv}` : '无需凭据'}</p>
          </div>
          <div className="mt-auto flex flex-wrap gap-2">
            <Button asChild icon="stage-resources"><Link to={serverBrowsePath(s.id)}>浏览资源</Link></Button>
            <Button variant="danger" icon="trash" onClick={() => setDeleting(s)}>删除服务</Button>
          </div>
        </li>)}
      </ul>
    </section>
    <Modal open={!!deleting} title="删除 MCP 服务" onClose={() => { if (!deletion.busy) setDeleting(null) }} footer={<>
      <Button disabled={deletion.busy} onClick={() => setDeleting(null)}>取消</Button>
      <Button variant="danger" loading={deletion.busy} onClick={() => deleting && void deletion.run(signal => removeServer(deleting.id, signal), () => { setDeleting(null); servers.reload() })}>确认删除</Button></>}>
      <p>确认移除「{deleting?.name}」？引用此服务的配方将无法读取资源。</p>
      {deletion.error && <p role="alert" className="text-err">{deletion.error}</p>}
    </Modal>
  </div>
}
