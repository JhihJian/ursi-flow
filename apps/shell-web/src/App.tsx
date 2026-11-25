import { WorkspaceShell, useWorkspace } from '@ursi/workspace-shell'
import { useShellRegistry, SETTINGS, REGISTRY } from './registry'

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
  const { modules, views, profiles } = useShellRegistry()
  return (
    <WorkspaceShell
      modules={modules}
      views={views}
      profiles={profiles}
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
