import { Link } from 'react-router'
import { unavailable, type useBackendMatch } from './use-backend-match'
import { Button } from '@/shared/ui/button'
import { Choice } from './Fields'

export function BackendChoice({ match, id, change }: { match: ReturnType<typeof useBackendMatch>; id: string; change: (id: string) => void }) {
  const { choices, items } = match
  const selected = choices.find(b => b.id === id)
  const previous = items.find(b => b.id === id)
  const reasons = [...new Set(items.map(unavailable).filter(Boolean))].join('、')
  return <div className="space-y-2">
    {match.loading ? <p role="status">正在匹配 Agent 后端…</p> : match.error ? <p role="alert">无法读取此配置包的后端匹配结果。 <Button onClick={match.reload}>重新匹配</Button></p> : <>
      {!!id && !selected && <p role="alert">原后端 {id} {previous ? unavailable(previous) : '已不在列表中'}，请重新选择或检查后端。</p>}
      {choices.length ? <>
        <Choice label="Agent 后端" required value={selected?.id ?? ''} change={change} options={[
          ['', '选择可用后端'], ...choices.map(b => [b.id, `${b.label}（${b.id}）`] as const),
        ]} />
        {choices.length > 1 && !selected && <p className="text-sm text-txt3">多个后端可用，请选择用于试跑和发布的后端。</p>}
      </> : <p role="status">没有可用的 Agent 后端：{reasons || '服务尚未列出任何后端'}。</p>}
    </>}
    <Link className="text-sm text-accent-2" to="/settings/agent-backends" state={{ fromAgentDraft: true }}>查看 Agent 后端设置</Link>
  </div>
}
