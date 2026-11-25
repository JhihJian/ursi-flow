import { WorkspaceShell, useWorkspace } from '@ursi/workspace-shell'
import { useShellRegistry, SETTINGS, REGISTRY } from './registry'

function HostButton({ kind, label }: { kind: { kind: string; id: string }; label: string }) {
  const { select } = useWorkspace()
  return (
    <button type="button" className="ws-settings" onClick={() => select(kind)}>
      {label}
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
          <HostButton kind={REGISTRY} label="Registry" />
          <HostButton kind={SETTINGS} label="Settings" />
        </>
      }
      status="todo · 8090"
      storageKey="ursi.workspace"
    />
  )
}
