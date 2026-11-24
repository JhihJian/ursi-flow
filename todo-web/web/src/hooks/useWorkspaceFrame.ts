import { useEffect, useMemo, useState } from 'react'
import {
  loadWorkspaceTarget,
  resolveWorkspaceUrl,
  type WorkspaceTarget,
} from '@/lib/workspace-target'
import { useTodoStore } from '@/store/todo-store'

export interface WorkspaceFrame {
  url: string
  embedUrl: string
  label: string
  taskTitle: string
}

/** 给嵌入地址补 `embed=1`，让被嵌页面收起自己的头部。 */
function withEmbedFlag(url: string) {
  try {
    const next = new URL(url, window.location.origin)
    next.searchParams.set('embed', '1')
    return next.toString()
  } catch {
    return url
  }
}

/**
 * 按 `workspace-config.json` 与当前选中任务算出要嵌入的页面。
 * 没有配置、没有选中任务或任务缺少 workspace / session 时 frame 为 null。
 */
export function useWorkspaceFrame() {
  const [target, setTarget] = useState<WorkspaceTarget | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    void loadWorkspaceTarget().then((value) => {
      if (!alive) return
      setTarget(value)
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const task = useTodoStore((state) =>
    state.detail?.mode === 'view' ? state.detail.task : null,
  )
  const projects = useTodoStore((state) => state.projects)
  const projectName = task?.project_id
    ? (projects.find((candidate) => candidate.id === task.project_id)?.name ?? null)
    : null

  const frame = useMemo<WorkspaceFrame | null>(() => {
    if (!target || !task) return null
    const url = resolveWorkspaceUrl(target.urlTemplate, {
      id: task.id,
      project: projectName,
      workspace: task.workspace ?? null,
      sessionId: task.session_id ?? null,
    })
    if (!url) return null
    return {
      url,
      embedUrl: withEmbedFlag(url),
      label: target.label,
      taskTitle: task.title,
    }
  }, [projectName, target, task])

  return { loaded, frame }
}
