import type { Command, Layout } from '@/shared/api/work-projects'

export type ProjectMutation = {
  run: <T>(send: (signal: AbortSignal) => Promise<T>, done?: (result: T) => void) => void
  command: (action: Command, done?: (id?: string) => void) => void
  layout: (canvasId: string | null, layout: Layout, done?: () => void) => void
}
