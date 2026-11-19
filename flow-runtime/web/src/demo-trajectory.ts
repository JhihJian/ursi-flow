// 演示数据：两次节点执行的 Pi 会话切片，结构和 daemon 落盘的 JSONL 一致。
// 第二段的第一条 parentId 指向切片之外的条目，查看器按最后一条回溯，仍然只显示本段。
const session = {
  type: 'session',
  version: 3,
  id: 'pi-demo-review',
  timestamp: '2025-01-08T09:01:00.000Z',
  cwd: '/srv/projects/ursi-flow',
  modelId: 'deepseek-chat',
}
const row = (id: string, parentId: string | null, timestamp: string, message: unknown) => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message,
})
const text = (value: string) => [{ type: 'text', text: value }]

const analyze = [
  session,
  row('u1', null, '2025-01-08T09:01:00.000Z', {
    role: 'user',
    content: text('分析任务：评审首页改动。先读入口文件，再通过结果工具提交结论。'),
  }),
  row('a1', 'u1', '2025-01-08T09:01:03.000Z', {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先看首页入口，确认错误态是否覆盖。' },
      { type: 'text', text: '先读首页入口文件。' },
      { type: 'toolCall', id: 'call_read', name: 'read', arguments: { path: 'src/Home.tsx' } },
    ],
    usage: { input: 1280, output: 96, cacheRead: 0, cacheWrite: 0 },
    durationMs: 2200,
  }),
  row('t1', 'a1', '2025-01-08T09:01:03.200Z', {
    role: 'toolResult',
    toolCallId: 'call_read',
    toolName: 'read',
    content: text('export function Home() {\n  return <main>首页</main>\n}\n'),
    isError: false,
    durationMs: 120,
  }),
  row('a2', 't1', '2025-01-08T09:01:05.000Z', {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '首页缺少错误态，需要补充说明后再交付。',
      },
      {
        type: 'toolCall',
        id: 'call_outcome_1',
        name: 'submit_flow_outcome',
        arguments: {
          outcome: '已分析',
          variables: { 分析结论: '需要补充错误态说明' },
        },
      },
    ],
    usage: { input: 1420, output: 88, cacheRead: 0, cacheWrite: 0 },
    durationMs: 1800,
  }),
  row('t2', 'a2', '2025-01-08T09:01:05.100Z', {
    role: 'toolResult',
    toolCallId: 'call_outcome_1',
    toolName: 'submit_flow_outcome',
    content: text('节点结果已记录：已分析'),
    isError: false,
    durationMs: 30,
  }),
]

const finish = [
  session,
  row('u2', 'a2', '2025-01-08T09:02:00.000Z', {
    role: 'user',
    content: text('完成任务：按分析结论补充错误态，并通过结果工具提交。'),
  }),
  row('a3', 'u2', '2025-01-08T09:02:04.000Z', {
    role: 'assistant',
    content: [
      { type: 'text', text: '已补充错误态说明，任务完成。' },
      {
        type: 'toolCall',
        id: 'call_outcome_2',
        name: 'submit_flow_outcome',
        arguments: { outcome: '已完成' },
      },
    ],
    usage: { input: 1600, output: 64, cacheRead: 0, cacheWrite: 0 },
    durationMs: 1600,
  }),
  row('t3', 'a3', '2025-01-08T09:02:04.100Z', {
    role: 'toolResult',
    toolCallId: 'call_outcome_2',
    toolName: 'submit_flow_outcome',
    content: text('节点结果已记录：已完成'),
    isError: false,
    durationMs: 25,
  }),
]

const jsonl = (rows: unknown[]) => rows.map((item) => JSON.stringify(item)).join('\n') + '\n'

/** 按节点执行标识提供演示轨迹，和线上 run.trajectory 的返回字段一致。 */
export const demoSessions: Record<string, string> = {
  'nr-review-1': jsonl(analyze),
  'nr-review-2': jsonl(finish),
}
