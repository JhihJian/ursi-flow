export { WorkspaceShell } from './shell'
export { SidebarFrame } from './frame'
export { ProfilesEditor, createProfilesStore, useProfiles } from './profiles'
export { WorkspaceProvider, useWorkspace, useOptionalWorkspace } from './context'
export type {
  ModuleContext,
  ModuleSidebarProps,
  Selection,
  ShellHandle,
  WorkspaceAction,
  WorkspaceModule,
  WorkspaceProfile,
  WorkspaceShellProps,
  WorkspaceView,
} from './contracts'
export type { SidebarFrameProps } from './frame'
export type { ProfilesEditorProps, ProfilesStore, ProfilesStoreOptions } from './profiles'
