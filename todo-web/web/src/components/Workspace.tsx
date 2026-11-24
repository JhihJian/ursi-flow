import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ActiveTasksPanel } from './ActiveTasksPanel'
import { ProjectHeader } from './ProjectHeader'
import { ProjectSidebar } from './ProjectSidebar'
import { TaskDetailPanel } from './TaskDetailPanel'
import { TaskSection } from './TaskSection'

export function Workspace() {
  const layout = useDefaultLayout({ id: 'todo-web.columns' })

  return (
    <Group
      orientation="horizontal"
      className="workspace"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <Panel
        id="projects"
        className="panel panel-sidebar"
        defaultSize={240}
        minSize={180}
        maxSize={420}
        groupResizeBehavior="preserve-pixel-size"
      >
        <ProjectSidebar />
      </Panel>
      <Separator className="separator" title="Drag to resize, double-click to reset" />
      <Panel id="content" className="panel panel-content" minSize={380}>
        <ProjectHeader />
        <TaskSection />
      </Panel>
      <Separator className="separator" title="Drag to resize, double-click to reset" />
      <Panel
        id="detail"
        className="panel panel-right"
        defaultSize={300}
        minSize={240}
        maxSize={480}
        groupResizeBehavior="preserve-pixel-size"
      >
        <ActiveTasksPanel />
        <TaskDetailPanel />
      </Panel>
    </Group>
  )
}
