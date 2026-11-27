import { useState } from 'react'
import { ProjectEditorSheet } from './ProjectEditorSheet'
import { TaskDetailSheet } from './TaskDetailSheet'
import { TaskSection } from './TaskSection'
import { MenuContainerProvider } from './menu-container'

/** todo 工作区：任务列表与两个贴底浮层，不含模块标题区。 */
export function TodoWorkspace() {
  // 右键菜单 portal 进工作区根（不滚动），列表与关系图共用。
  const [menuContainer, setMenuContainer] = useState<HTMLDivElement | null>(null)
  return (
    <div className="todo-workspace" ref={setMenuContainer}>
      <MenuContainerProvider value={menuContainer}>
        <TaskSection />
        <ProjectEditorSheet />
        <TaskDetailSheet />
      </MenuContainerProvider>
    </div>
  )
}
