import { WorkspaceShell, useWorkspace, type WorkspaceView } from '@ursi/workspace-shell'
import { createTodoModule } from './modules/todo'
import { createWorkspaceModule } from '@workspace-web/module'
import '@workspace-web/module.css'

const modules = [createTodoModule(), createWorkspaceModule()]

/** 设置页不占栏，注册成不占栏的视图，由标题栏按钮选中它。 */
const SETTINGS = { kind: 'app.settings', id: 'settings' } as const

function SettingsView() {
  return (
    <div className="app-settings">
      <h2 className="app-settings-title">Settings</h2>
      <p>全局设置占位：后续放服务地址、执行器修订、主题与快捷键。</p>
    </div>
  )
}

const views: WorkspaceView[] = [
  {
    kind: SETTINGS.kind,
    summary: () => 'Settings',
    Component: SettingsView,
  },
]

function SettingsButton() {
  const { select } = useWorkspace()
  return (
    <button type="button" className="ws-settings" onClick={() => select(SETTINGS)}>
      Settings
    </button>
  )
}

export default function App() {
  return (
    <WorkspaceShell
      modules={modules}
      views={views}
      title="ursi workspace"
      settings={<SettingsButton />}
      status="todo · 8090"
      storageKey="ursi.workspace"
    />
  )
}
