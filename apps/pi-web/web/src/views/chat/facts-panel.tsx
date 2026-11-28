import { useEffect, useState, type ReactNode } from 'react'
import { formatWhen } from '../sessions/lib/format'
import { fetchSessionFacts, type ModelChange, type SessionFacts } from './facts-api'

/**
 * 「本次运行」面板：这次会话实际上用了什么模型、看到哪些 skills、连了哪些 MCP server、
 * 有哪些工具可用。事实由服务端给出，面板只展示，不推断也不反查 pi home 的配置。
 *
 * 默认折叠成一行。折叠状态是纯展示状态，留在组件本地，不进全局 store。
 * 拉不到事实（路由未上、无本地运行时、老会话）时面板整块不出现。
 */

/** 事实里缺项时的统一说法：是「没记」，不是「没有」。 */
const ABSENT = '未记录'

export interface FactsPanelProps {
  sessionId: string
  /** 事件流的节流计数：transcript、state、agent_settled 帧到达后递增，变一次重拉一次。 */
  tick: number
}

export function FactsPanel({ sessionId, tick }: FactsPanelProps) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<{ forId: string; facts: SessionFacts | null } | null>(null)

  // 换会话或收到新帧就重拉；切换与卸载时中止在途请求，旧结果不会写进新会话的面板。
  useEffect(() => {
    const controller = new AbortController()
    void fetchSessionFacts(sessionId, controller.signal).then((facts) => {
      if (controller.signal.aborted) return
      setLoaded({ forId: sessionId, facts })
    })
    return () => controller.abort()
  }, [sessionId, tick])

  // 上一条会话的结果不能顶到这一条的标题上：对不上就当没拉到。
  const facts = loaded && loaded.forId === sessionId ? loaded.facts : null
  if (!facts) return null

  const source = facts.source === 'runtime' ? '实时' : '历史文件'

  // 老会话没有 system message：能确认的事实一个都没有，展开也没有内容可看。
  if (!facts.recorded) {
    return (
      <section className="pichat-facts">
        <div className="pichat-facts-head">
          <span className="pichat-facts-title">本次运行</span>
          <span className="pichat-facts-summary">此会话未记录运行事实（老会话没有 system message）</span>
          <span className="pichat-facts-source">{source}</span>
        </div>
      </section>
    )
  }

  return (
    <section className={`pichat-facts${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="pichat-facts-head"
        aria-expanded={open}
        title={open ? '收起本次运行' : '展开本次运行'}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="pichat-facts-title">本次运行</span>
        {open ? null : <span className="pichat-facts-summary">{summaryOf(facts)}</span>}
        <span className="pichat-facts-source">{source}</span>
        <span className="pichat-facts-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open ? <FactsBody facts={facts} /> : null}
    </section>
  )
}

function FactsBody({ facts }: { facts: SessionFacts }) {
  const model = facts.model
  const listed = facts.skills.listed
  const read = facts.skills.read ?? []
  const readNames = new Set(read.map((skill) => skill.name))
  // 读过但没在清单里的 skill 也要露出来：它确实进过这次会话。
  const skillNames = [...(listed?.map((skill) => skill.name) ?? []), ...read.map((skill) => skill.name)].filter(
    (name, index, all) => all.indexOf(name) === index,
  )
  const servers = facts.mcp.servers
  const sections = facts.promptSectionKeys ?? null

  return (
    <dl className="pichat-facts-body">
      <FactRow label="模型">
        <span>{refText(model.initial)}</span>
        {model.current && refText(model.current) !== refText(model.initial) ? (
          <>
            <span className="pichat-facts-sep">→</span>
            <span>{refText(model.current)}</span>
          </>
        ) : null}
        {model.changes.length > 0 ? (
          <span className="pichat-facts-hint" title={changeLog(model.changes)}>
            中途切换过 {model.changes.length} 次
          </span>
        ) : null}
        <span className="pichat-facts-hint">思考级别 {model.thinkingLevel ?? ABSENT}</span>
      </FactRow>

      <FactRow label="Skills">
        {listed === null && facts.skills.read === null ? (
          <span className="pichat-facts-hint">{ABSENT}</span>
        ) : (
          <>
            <span className="pichat-facts-hint">列出 {listed?.length ?? 0} 个</span>
            {skillNames.length > 0 ? (
              <span className="pichat-facts-tags">
                {skillNames.map((name) => (
                  <span
                    key={name}
                    className={`pichat-facts-tag${readNames.has(name) ? ' is-read' : ''}`}
                  >
                    {name}
                    {readNames.has(name) ? <span className="pichat-facts-mark">已读取</span> : null}
                  </span>
                ))}
              </span>
            ) : null}
          </>
        )}
      </FactRow>

      <FactRow label="MCP">
        {servers === null ? <span className="pichat-facts-hint">{ABSENT}</span> : null}
        {servers !== null && servers.length === 0 ? (
          <span className="pichat-facts-hint">没有连 MCP server</span>
        ) : null}
        {servers !== null && servers.length > 0 ? (
          <span className="pichat-facts-tags">
            {servers.map((server) => (
              <span key={server} className="pichat-facts-tag">
                {server}
              </span>
            ))}
          </span>
        ) : null}
        {facts.mcp.note ? <span className="pichat-facts-hint">{facts.mcp.note}</span> : null}
      </FactRow>

      <FactRow label="工具">
        <span>{facts.tools.names === null ? ABSENT : `${facts.tools.names.length} 个`}</span>
      </FactRow>

      <FactRow label="提示词分区">
        {/* 只给个数，分区名一长串挤在行里没有价值：悬停可看全。 */}
        <span title={sections ? sections.join(' · ') : undefined}>
          {sections === null ? ABSENT : `${sections.length} 个`}
        </span>
      </FactRow>
    </dl>
  )
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pichat-facts-row">
      <dt className="pichat-facts-label">{label}</dt>
      <dd className="pichat-facts-value">{children}</dd>
    </div>
  )
}

function refText(identity: { provider: string; model: string } | null): string {
  return identity ? `${identity.provider}/${identity.model}` : ABSENT
}

/** 折叠时的摘要：一行说清这次运行的主要事实。 */
function summaryOf(facts: SessionFacts): string {
  const model = facts.model.current ?? facts.model.initial
  const parts = [model ? `${model.provider}/${model.model}` : `模型${ABSENT}`]
  const skills = facts.skills.listed
  if (skills) parts.push(`${skills.length} 个 skill`)
  const servers = facts.mcp.servers
  if (servers && servers.length > 0) parts.push(`${servers.length} 个 MCP`)
  const tools = facts.tools.names
  if (tools) parts.push(`${tools.length} 个工具`)
  return parts.join(' · ')
}

/** 每次切换悬停可见：切换后的模型与切换时间。 */
function changeLog(changes: ModelChange[]): string {
  return changes.map((change) => `${formatWhen(change.at)} ${change.provider}/${change.model}`).join('\n')
}
