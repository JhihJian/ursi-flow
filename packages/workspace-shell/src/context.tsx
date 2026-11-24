import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Selection } from './contracts'

interface WorkspaceContextValue {
  selection: Selection | null
  select: (selection: Selection | null) => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const select = useCallback((next: Selection | null) => setSelection(next), [])
  const value = useMemo(() => ({ selection, select }), [selection, select])
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用')
  return value
}

/** 模块栏自己的尺寸控制：模块内部折叠、展开时可直接请求栏宽。 */
export interface ModuleColumnValue {
  width: number
  collapsed: boolean
  resize: (width: number) => void
  collapse: () => void
  expand: () => void
}

const ModuleColumnContext = createContext<ModuleColumnValue | null>(null)

export function ModuleColumnProvider({
  value,
  children,
}: {
  value: ModuleColumnValue
  children: ReactNode
}) {
  return <ModuleColumnContext.Provider value={value}>{children}</ModuleColumnContext.Provider>
}

export function useModuleColumn(): ModuleColumnValue {
  const value = useContext(ModuleColumnContext)
  if (!value) throw new Error('useModuleColumn 必须在模块栏内使用')
  return value
}
