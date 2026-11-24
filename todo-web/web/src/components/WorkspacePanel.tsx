import { useEffect, useState } from 'react'
import {
  loadWorkspaceTarget,
  resolveWorkspaceUrl,
  type WorkspaceTarget,
} from '@/lib/workspace-target'
import { useTodoStore } from '@/store/todo-store'

/**
 * 工作台只负责「按配置嵌入别人的页面」，执行详情由外部页面自己实现。
 * 没有配置、没有选中任务或任务缺少 workbench 字段时不渲染任何内容。
 */
export function WorkspacePanel() {
  const [target, setTarget] = useState<WorkspaceTarget | null>(null)

  useEffect(() => {
    let alive = true
    void loadWorkspaceTarget().then((value) => {
      if (!alive) return
      setTarget(value)
    })
    return () => {
      alive = false
    }
  }, [])

  const task = useTodoStore((state) =>
    state.detail?.mode === 'view' ? state.detail.task : null,
  )
  const projects = useTodoStore((state) => state.projects)
  const project = task?.project_id
    ? projects.find((candidate) => candidate.id === task.project_id)
    : undefined

  const url = target && task
    ? resolveWorkspaceUrl(target.urlTemplate, {
        id: task.id,
        project: project?.name ?? null,
        workspace: task.workspace ?? null,
        sessionId: task.session_id ?? null,
      })
    : null

  if (!url) return null

  // 嵌入时关掉被嵌页自带的头部，避免宿主栏与页面栏叠成两条。
  const embedUrl = (() => {
    try {
      const next = new URL(url, window.location.origin)
      next.searchParams.set('embed', '1')
      return next.toString()
    } catch {
      return url
    }
  })()

  return (
    <div className="workspace-panel">
      <div className="workspace-bar">
        <span className="workspace-bar-title">{target?.label}</span>
        <span className="workspace-bar-task">{task?.title}</span>
        <a className="workspace-bar-link" href={url} target="_blank" rel="noreferrer">
          Open in new tab ↗
        </a>
      </div>
      <iframe
        className="workspace-frame"
        src={embedUrl}
        title={`${target?.label} for ${task?.title ?? 'task'}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  )
}
