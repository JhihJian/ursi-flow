import type { Artifact, ChatSession, Connection, Role, Run, Sandbox, Workflow } from '@/shared/api/types'

export interface DemoSettings { delay: number; failNext: boolean }
export interface MockState {
  roles: Role[]; connections: Connection[]; workflows: Workflow[]
  runs: Run[]; artifacts: Artifact[]; sandboxes: Sandbox[]; chatSessions: ChatSession[]
  settings: DemoSettings; sequence: number; clocks: Record<string, Record<string, number>>
}
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 每次生成全新对象，运行快照与可编辑配置也彼此独立。 */
export function createSeed(now: number, delay = 180): MockState {
  const at = new Date(now - 3_600_000).toISOString()
  const chatAt = new Date(now - 3_500_000).toISOString()
  const connections: Connection[] = [
    { id: 'conn-openai', name: '团队研发模型', provider: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', credentialRef: 'vault://team/openai', updatedAt: at },
    { id: 'conn-anthropic', name: '长文档分析模型', provider: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4', credentialRef: 'vault://team/anthropic', updatedAt: at },
  ]
  const roles: Role[] = [
    { id: 'role-product', name: '产品分析师', description: '把业务诉求整理为可验证的需求与交付范围。', icon: '◎', color: '#6366f1', systemPrompt: '你是经验丰富的产品分析师。澄清使用场景，输出用户故事、边界条件和验收标准。', model: 'gpt-4.1', connectionId: 'conn-openai', executor: 'claude-code', skills: [{ name: '需求分析.md', content: '# 需求分析\n围绕目标用户、核心场景和可验证结果编写需求。' }], mcpServers: [], updatedAt: at },
    { id: 'role-developer', name: '交付工程师', description: '实现经过确认的方案，并补齐自动化验证。', icon: '⌘', color: '#0ea5e9', systemPrompt: '你负责工程交付。遵循项目约定，保持实现清晰，完成测试并记录验证结果。', model: 'gpt-4.1', connectionId: 'conn-openai', executor: 'codex', skills: [], mcpServers: [], updatedAt: at },
    { id: 'role-reviewer', name: '代码审查员', description: '审查正确性、异常路径与可维护性。', icon: '◇', color: '#10b981', systemPrompt: '你是代码审查员。依据差异与测试证据提出可操作的建议，按影响程度排序。', model: 'claude-sonnet-4', connectionId: 'conn-anthropic', executor: 'claude-code', skills: [{ name: '审查清单.md', content: '# 审查清单\n检查输入校验、权限边界、异常恢复与回归测试。' }], mcpServers: [], updatedAt: at },
    { id: 'role-writer', name: '技术文档编辑', description: '将零散材料整理为清晰、可检索的团队知识。', icon: '▤', color: '#f59e0b', systemPrompt: '你负责技术文档。先说明结论和使用场景，再给出操作步骤、示例及必要背景。', model: 'claude-sonnet-4', connectionId: 'conn-anthropic', executor: 'claude-code', skills: [], mcpServers: [], updatedAt: at },
  ]
  const workflows: Workflow[] = [
    { id: 'wf-product', name: '产品需求交付', description: '从业务需求到方案确认、工程实现与交付说明。', nodes: [{ id: 'discover', name: '梳理需求', type: 'agent', roleId: 'role-product' }, { id: 'confirm', name: '确认交付范围', type: 'approval' }, { id: 'implement', name: '实现与验证', type: 'agent', roleId: 'role-developer' }, { id: 'handoff', name: '编写交付说明', type: 'agent', roleId: 'role-writer' }], edges: [{ source: 'discover', target: 'confirm' }, { source: 'confirm', target: 'implement' }, { source: 'implement', target: 'handoff' }], updatedAt: at },
    { id: 'wf-review', name: '代码审查', description: '检查变更影响，产出审查报告与回归建议。', nodes: [{ id: 'review', name: '审查代码变更', type: 'agent', roleId: 'role-reviewer' }, { id: 'report', name: '汇总审查结论', type: 'agent', roleId: 'role-writer' }], edges: [{ source: 'review', target: 'report' }], updatedAt: at },
    { id: 'wf-docs', name: '文档整理', description: '汇总项目资料，形成结构清晰的团队知识库。', nodes: [{ id: 'collect', name: '整理现有资料', type: 'agent', roleId: 'role-writer' }, { id: 'publish', name: '生成知识库索引', type: 'agent', roleId: 'role-writer' }], edges: [{ source: 'collect', target: 'publish' }], updatedAt: at },
  ]
  const runs: Run[] = workflows.map((workflow, i) => {
    const usedRoles = roles.filter(role => workflow.nodes.some(node => node.roleId === role.id))
    const statuses = ['waiting', 'succeeded', 'running'] as const
    const names = ['客户反馈看板 · 需求确认', '支付重试逻辑 · 审查完成', '新成员入职指南 · 整理中']
    const input = ['为客户成功团队设计反馈看板，支持按客户分组、优先级筛选和进度追踪。', '检查支付失败后的重试逻辑，重点关注幂等处理与超时恢复。', '汇总开发环境、提交流程和常见故障，整理为新成员入职指南。'][i]!
    return {
      id: `run-${i + 1}`, name: names[i]!, workflowId: workflow.id, workflowName: workflow.name, status: statuses[i]!, createdAt: at, updatedAt: at, attempt: 1,
      nodes: workflow.nodes.map((node, index) => ({ id: node.id, name: node.name, type: node.type, ...(node.roleId ? { roleId: node.roleId } : {}), status: i === 1 || (i === 0 && index === 0) ? 'succeeded' : i === 0 && index === 1 ? 'waiting_approval' : i === 2 && index === 0 ? 'running' : 'pending', ...(i === 1 || (i === 0 && index === 0) ? { output: `${node.name}已完成，详见交付产物。` } : {}) })),
      snapshot: clone({ workflow, roles: usedRoles, connections: connections.filter(connection => usedRoles.some(role => role.connectionId === connection.id)) }),
      events: [{ id: `run-${i + 1}-event-000001`, at, type: 'state', message: '运行已创建，配置快照已保存。' }, { id: `run-${i + 1}-event-000002`, at, type: 'state', message: ['需求草案已完成，等待确认交付范围。', '审查报告已生成，运行完成。', '正在整理开发环境与入职资料。'][i]! }],
      sandboxId: `sandbox-${i + 1}`, input,
    }
  })
  const artifactContents = [
    '# 客户反馈看板需求草案\n\n## 业务目标\n让客户成功团队在一个页面掌握重点客户的反馈与处理进度。\n\n## 本期范围\n- 按客户、优先级与状态筛选反馈\n- 反馈关联负责人和预计完成日期\n- 保留处理记录，支持导出周报\n\n## 验收标准\n筛选结果与列表统计一致，状态变更后可查询完整记录。\n',
    '# 支付重试审查报告\n\n## 结论\n关键路径验证通过，建议合并。\n\n## 审查记录\n- 幂等键在首次请求与重试请求之间保持一致\n- 超时后查询交易状态，避免重复扣款\n- 失败重试采用指数退避，最多三次\n\n## 回归结果\n正常支付、网络超时与重复通知场景均通过。\n',
    '# 回归验证建议\n\n| 场景 | 预期 | 结果 |\n| --- | --- | --- |\n| 支付回调重复到达 | 仅入账一次 | 通过 |\n| 网关响应超时 | 先查询再重试 | 通过 |\n| 超过重试上限 | 转入人工处理 | 通过 |\n',
  ]
  const artifacts: Artifact[] = artifactContents.map((content, i) => ({ id: `artifact-${i + 1}`, name: ['需求草案.md', '代码审查报告.md', '回归验证建议.md'][i]!, path: `/workspace/output/${['requirements.md', 'review.md', 'regression.md'][i]}`, contentType: 'text/markdown', content, runId: i === 0 ? 'run-1' : 'run-2', nodeId: ['discover', 'review', 'report'][i]!, attempt: 1, size: new TextEncoder().encode(content).length, createdAt: at }))
  const sandboxes: Sandbox[] = runs.map((run, i) => ({ id: run.sandboxId, name: `交付工作区 ${String(i + 1).padStart(2, '0')}`, runId: run.id, status: i === 1 ? 'released' : 'running', image: 'ursi/agent-workspace:demo', createdAt: at, cpu: '2 vCPU', memory: '4 GiB', workspace: '/workspace', logs: ['模拟工作区已准备。', '配置快照已加载。', i === 1 ? '运行完成，模拟资源已释放。' : '工作区待命，等待后续任务。'] }))
  const chatSessions: ChatSession[] = [{
    id: 'chat-1', title: '了解当前演示数据', createdAt: at, updatedAt: chatAt,
    messages: [
      { id: 'chat-1-message-1', role: 'user', at, parts: [{ type: 'text', text: '现在有哪些工作流和运行？' }] },
      {
        id: 'chat-1-message-2', role: 'assistant', at: chatAt, parts: [
          { type: 'reasoning', text: '先读取演示数据中的工作流与运行记录，再汇总当前状态。' },
          { type: 'tool', name: '读取运行记录', status: 'succeeded', output: `共 ${runs.length} 条运行` },
          { type: 'text', text: `当前有 ${workflows.length} 个工作流和 ${runs.length} 条运行记录。\n\n- 产品需求交付：等待审批\n- 代码审查：已完成\n- 文档整理：执行中\n\n> 以上内容由本地演示模板生成，未调用任何模型。` },
        ],
      },
    ],
  }]
  return { roles, connections, workflows, runs, artifacts, sandboxes, chatSessions, settings: { delay, failNext: false }, sequence: 100, clocks: { 'run-3': { collect: now } } }
}
