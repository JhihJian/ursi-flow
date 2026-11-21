import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { checkAgentBackend, listAgentBackends, type AgentBackend } from '@/shared/api/agent-backends'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'

const connectivity = { unchecked: '未检查', ready: '已连通', failed: '检查失败' }
const tones = { unchecked: 'text-txt3', ready: 'text-ok', failed: 'text-err' }
const capabilityNames = { skills: 'Skills', tools: 'Tools' }
const localTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })

function BackendRow({ initial }: { initial: AgentBackend }) {
  const [backend, setBackend] = useState(initial)
  const check = useMutation()
  const { id, label, configured, capabilities, status, checkedAt } = backend
  const date = checkedAt === null ? null : new Date(checkedAt)
  return <li className="grid min-w-0 gap-3 border-b border-line py-4 lg:grid-cols-[minmax(9rem,1fr)_minmax(20rem,2fr)_auto] lg:items-center">
    <div className="min-w-0"><h2 className="break-words font-semibold">{label}</h2><small className="break-all font-mono text-txt3">{id}</small></div>
    <dl className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-[auto_auto_auto_1fr]">
      <div><dt className="text-xs text-txt3">配置状态</dt><dd>{configured ? '已配置' : '未配置'}</dd></div>
      <div><dt className="text-xs text-txt3">能力</dt><dd>{capabilities.map(c => capabilityNames[c]).join('、') || '无'}</dd></div>
      <div><dt className="text-xs text-txt3">最近连通性</dt><dd className={tones[status]}>{connectivity[status]}</dd></div>
      <div><dt className="text-xs text-txt3">检查时间</dt><dd>{date ? <time dateTime={date.toISOString()}>{localTime.format(date)}</time> : '暂无记录'}</dd></div>
    </dl>
    <div><Button icon="refresh" size="sm" disabled={!configured} loading={check.busy} aria-label={`检查 ${label} 连通性`}
      onClick={() => check.run(signal => checkAgentBackend(id, signal), setBackend)}>检查连通性</Button></div>
    {check.error && <p className="text-sm text-err lg:col-span-full" role="alert">未取得检查结果，请重试。</p>}
  </li>
}

export function AgentBackends() {
  const list = useResource(listAgentBackends, [])
  const location = useLocation()
  const navigate = useNavigate()
  return <section className="page-stack">
    <PageHeader title="Agent 后端" actions={location.state?.fromAgentDraft && <Button icon="arrow-left" onClick={() => navigate(-1)}>返回执行器草稿</Button>} />
    <p className="text-sm text-txt2">连通性检查仅验证适配器控制接口，不运行模型，也不验证 Skills 或工具能否执行。</p>
    {list.loading || list.error || !list.data.length ? <ResourceState loading={list.loading} error={!!list.error} empty
      title={list.error ? '无法读取 Agent 后端' : '暂无 Agent 后端'} description={list.error ? '请重新加载后再试。' : '请联系管理员配置适配器。'} onRetry={list.reload} /> :
      <ul aria-label="Agent 后端列表" className="border-t border-line">{list.data.map(item => <BackendRow key={item.id} initial={item} />)}</ul>}
  </section>
}
