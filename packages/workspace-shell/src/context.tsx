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
  if (!value) throw new Error('useWorkspace 必须在 WorkspaceShell 内使用')
  return value
}

/** 同一份选中，供模块在独立入口里做可选读取。 */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext)
}
