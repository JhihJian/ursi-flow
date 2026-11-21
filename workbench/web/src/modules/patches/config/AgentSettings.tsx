import { agentOptions } from '@/shared/api/agent-executor'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'

/** Shares the file editor's draft and save action; opening the picker never rewrites the file. */
export function AgentSettings({ text, change }: { text: string; change: (text: string) => void }) {
  const options = useResource(agentOptions, null)
  // The caller only mounts this picker for a valid top-level JSON object.
  const value: Record<string, unknown> = JSON.parse(text)
  const model = value.modelProfile
  const tools = value.tools ?? []
  if ((model !== undefined && typeof model !== 'string') || !Array.isArray(tools) || !tools.every(v => typeof v === 'string') || value.tools === null ||
      Object.keys(value).some(key => !['modelProfile', 'tools', 'mcpServers'].includes(key)) || Object.keys(value.mcpServers ?? {}).length) {
    return <p className="text-xs text-warn">当前 MCP 配置不能用于 Agent 执行器。仅支持受管模型和获准工具，不支持自定义服务。</p>
  }
  if (options.loading) return <p role="status">正在读取受管模型和工具…</p>
  if (options.error) return <div>{options.error} <Button onClick={options.reload}>重试</Button></div>
  const models = options.data?.models.map(m => m.id) ?? []
  const allowed = options.data?.tools.map(t => t.id) ?? []
  const saveDraft = (fields: Record<string, unknown>) => change(JSON.stringify({ ...value, ...fields }, null, 2) + '\n')
  return <fieldset className="space-y-2 text-sm"><legend className="field-label">Agent 设置</legend>
    <label className="flex flex-wrap items-center gap-2">受管模型<select className="select" value={model ?? ''} onChange={e => saveDraft({ modelProfile: e.target.value || undefined })}>
      <option value="">{models.length ? `平台默认（${models[0]}）` : '暂无可用模型'}</option>
      {model && !models.includes(model) && <option value={model}>{model}（不可用）</option>}
      {models.map(id => <option key={id} value={id}>{id}</option>)}
    </select></label>
    <fieldset><legend className="field-label">只读工具</legend>
      {Array.from(new Set([...allowed, ...tools])).map(id => <label key={id} className="mr-4 inline-flex items-center gap-1 break-all">
        <input type="checkbox" checked={tools.includes(id)} onChange={e => saveDraft({ tools: e.target.checked ? [...tools, id] : tools.filter(t => t !== id) })} />{id}{allowed.includes(id) ? '' : '（不可用）'}
      </label>)}
      {!allowed.length && !tools.length && <span className="text-xs text-txt3">无获准工具</span>}
    </fieldset>
  </fieldset>
}
