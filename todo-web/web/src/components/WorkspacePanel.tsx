import type { WorkspaceFrame } from '@/hooks/useWorkspaceFrame'

/** 工作台只负责按配置嵌入别人的页面，执行详情由外部页面自己实现。 */
export function WorkspacePanel({ frame }: { frame: WorkspaceFrame }) {
  return (
    <div className="workspace-panel">
      <div className="workspace-bar">
        <span className="workspace-bar-title">{frame.label}</span>
        <span className="workspace-bar-task">{frame.taskTitle}</span>
        <a className="workspace-bar-link" href={frame.url} target="_blank" rel="noreferrer">
          Open in new tab ↗
        </a>
      </div>
      <iframe
        className="workspace-frame"
        src={frame.embedUrl}
        title={`${frame.label} for ${frame.taskTitle}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  )
}
