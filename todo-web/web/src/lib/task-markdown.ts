import type { Priority, TaskStatus } from '@/api/types'

export interface TaskMarkdownInput {
  title: string
  status: TaskStatus
  priority: Priority
  tags: string[]
  note: string
  /** 面板上显示的时间信息，没有任务时传 null。 */
  timeInfo: string | null
}

/** 把详情面板的内容拼成一份 Markdown 文档，用于复制到别处。 */
export function buildTaskMarkdown({
  title,
  status,
  priority,
  tags,
  note,
  timeInfo,
}: TaskMarkdownInput): string {
  const lines = [`# ${title.trim() || 'Untitled task'}`, '']
  lines.push(`- Status: ${status}`, `- Priority: ${priority}`)
  if (tags.length > 0) lines.push(`- Tags: ${tags.map((tag) => `#${tag}`).join(' ')}`)
  if (timeInfo) lines.push(`- Time: ${timeInfo}`)
  const body = note.trim()
  if (body) lines.push('', body)
  return `${lines.join('\n')}\n`
}
