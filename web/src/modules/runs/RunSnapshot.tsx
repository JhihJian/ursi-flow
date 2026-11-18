import type { Run } from '@/shared/api/types'

const pretty = (value: unknown) => JSON.stringify(value, null, 2)

/** 冻结配置展示：全部内容取自运行时保存的 snapshot，与当前配置编辑无关。 */
export function RunSnapshot({ snapshot }: { snapshot: Run['snapshot'] }) {
  return (
    <div className="space-y-5">
      <p className="text-xs leading-6 text-txt3">以下是创建运行时保存的配置。工作流与角色之后的修改不会改变这份快照。</p>
      <section>
        <h3 className="mb-2 text-sm font-medium">{snapshot.workflow.name}</h3>
        <p className="text-sm text-txt3">{snapshot.workflow.description || '暂无描述'}</p>
        <details className="mt-3 overflow-hidden rounded-lg border border-line">
          <summary className="cursor-pointer bg-elevated/40 px-3.5 py-3 text-xs font-medium">流程节点与连线</summary>
          <pre className="whitespace-pre-wrap break-words p-3.5 text-xs leading-7 text-txt2">
            {pretty({ nodes: snapshot.workflow.nodes, edges: snapshot.workflow.edges })}
          </pre>
        </details>
      </section>
      <section>
        <h3 className="mb-3 text-sm font-medium">
          角色配置 <span className="text-txt3">{snapshot.roles.length}</span>
        </h3>
        {snapshot.roles.length ? null : <p className="text-xs text-txt3">该流程没有引用角色。</p>}
        {snapshot.roles.map((role) => (
          <details key={role.id} className="mb-2 overflow-hidden rounded-lg border border-line">
            <summary className="cursor-pointer bg-elevated/40 px-3.5 py-3 text-xs font-medium">
              {role.name} <span className="ml-2 font-normal text-txt3">{role.model}</span>
            </summary>
            <div className="space-y-4 p-4">
              <dl className="grid grid-cols-[70px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                <dt className="text-txt3">角色标识</dt>
                <dd>{role.id}</dd>
                <dt className="text-txt3">执行器</dt>
                <dd>{role.executor}</dd>
                <dt className="text-txt3">模型连接</dt>
                <dd>{snapshot.connections.find((connection) => connection.id === role.connectionId)?.name || role.connectionId}</dd>
              </dl>
              <div>
                <h4 className="text-xs font-medium">系统提示词</h4>
                <pre className="!px-0 !pb-0">{role.systemPrompt || '未配置'}</pre>
              </div>
              <div>
                <h4 className="mb-2 text-xs font-medium">技能 · {role.skills.length}</h4>
                {role.skills.map((skill, index) => (
                  <details key={`${role.id}-skill-${index}`} className="mb-2 overflow-hidden rounded-lg border border-line">
                    <summary className="cursor-pointer bg-elevated/40 px-3.5 py-3 text-xs font-medium">{skill.name}</summary>
                    <pre>{skill.content || '无内容'}</pre>
                  </details>
                ))}
                {role.skills.length ? null : <p className="text-xs text-txt3">未配置技能</p>}
              </div>
              <div>
                <h4 className="mb-2 text-xs font-medium">MCP 服务 · {role.mcpServers.length}</h4>
                {role.mcpServers.length
                  ? <pre className="!p-0">{pretty(role.mcpServers)}</pre>
                  : <p className="text-xs text-txt3">未配置 MCP 服务</p>}
              </div>
            </div>
          </details>
        ))}
      </section>
      {snapshot.connections.length ? (
        <details className="overflow-hidden rounded-lg border border-line">
          <summary className="cursor-pointer bg-elevated/40 px-3.5 py-3 text-xs font-medium">模型连接快照 · {snapshot.connections.length}</summary>
          <pre>{pretty(snapshot.connections)}</pre>
        </details>
      ) : null}
    </div>
  )
}

export default RunSnapshot
