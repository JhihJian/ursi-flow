import { WorkspaceShell, type WorkspaceRegionProps } from '@ursi/workspace-shell'
import { createTodoModule } from './modules/todo'

const modules = [createTodoModule()]

/** 顶部与底部的横栏先放占位，后续接全局工具条与执行输出。 */
const top: WorkspaceRegionProps = {
  title: 'Toolbar',
  defaultSize: 96,
  content: (
    <p className="ws-hint">
      全局工具条占位：后续放项目切换、批量操作、筛选等跨模块控件。
    </p>
  ),
}

const bottom: WorkspaceRegionProps = {
  title: 'Output',
  defaultSize: 140,
  content: (
    <p className="ws-hint">
      执行输出占位：后续放当前任务的运行日志、制品与事件流。
    </p>
  ),
}

export default function App() {
  return (
    <WorkspaceShell
      modules={modules}
      top={top}
      bottom={bottom}
      storageKey="ursi.workspace"
    />
  )
}
