declare module 'pi-agent-trajectory-viewer' {
  export interface TrajectoryStats {
    lines: number
    activeLines: number
    messages: number
    turns: number
    tools: number
  }

  export interface ParsedSession {
    header: Record<string, unknown>
    rows: unknown[]
    diagnostics: unknown[]
    turns: unknown[]
    stats: TrajectoryStats
  }

  export function parsePiJsonl(text: string): ParsedSession

  export function TrajectoryViewer(props: {
    turns: unknown[]
    rows?: unknown[]
    diagnostics?: unknown[]
    sessionRevision?: number
    defaultDuration?: boolean
    defaultView?: string
    defaultQuery?: string
    className?: string
    onSelectionChange?: (selection: unknown) => void
  }): JSX.Element
}

declare module 'pi-agent-trajectory-viewer/style.css'
