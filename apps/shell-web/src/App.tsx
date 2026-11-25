import { WorkspaceShell, useWorkspace } from '@ursi/workspace-shell'
import { buildRegistry, SETTINGS } from './registry'

const { modules, views } = buildRegistry()

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
