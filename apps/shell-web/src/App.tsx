import { WorkspaceShell, useWorkspace } from '@ursi/workspace-shell'
import { useShellRegistry, SETTINGS, REGISTRY } from './registry'

const { modules, views } = useShellRegistry()

function SettingsButton() {
  const { select } = useWorkspace()
  return (
    <button type="button" className="ws-settings" onClick={() => select(SETTINGS)}>
      Settings
    </button>
  )
}

function RegistryButton() {
  const { select } = useWorkspace()
  return (
    <button type="button" className="ws-settings" onClick={() => select(REGISTRY)}>
      Registry
    </button>
  )
}

export default function App() {
  return (
    <WorkspaceShell
      modules={modules}
      views={views}
      title="ursi workspace"
      settings={
        <>
          <RegistryButton />
          <SettingsButton />
        </>
      }
      status="todo · 8090"
      storageKey="ursi.workspace"
    />
  )
}
