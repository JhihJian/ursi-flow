import { WorkspaceShell } from '@ursi/workspace-shell'
import { createTodoModule } from './modules/todo'

const modules = [createTodoModule()]

export default function App() {
  return <WorkspaceShell modules={modules} storageKey="ursi.workspace" />
}
