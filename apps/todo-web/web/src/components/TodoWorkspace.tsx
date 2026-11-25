import { ProjectEditorSheet } from './ProjectEditorSheet'
import { TaskDetailSheet } from './TaskDetailSheet'
import { TaskSection } from './TaskSection'

/** todo 工作区：任务列表与两个贴底浮层，不含模块标题区。 */
export function TodoWorkspace() {
  return (
    <div className="todo-workspace">
      <TaskSection />
      <ProjectEditorSheet />
      <TaskDetailSheet />
    </div>
  )
}
