import { createSlotRegistry, type SlotRegistry } from '@ursi/ui-slots'
import type { ProjectInfo } from './project'
import { portalRegions, type PortalRegion } from './portal-regions'

export type PortalContext = Readonly<{ project: ProjectInfo; workbenchUrl?: string; revision?: string }>
export type PortalSlots = Record<PortalRegion, PortalContext>
export type PluginContext = Readonly<{
  slots: Pick<SlotRegistry<PortalSlots>, 'register'>
  signal: AbortSignal
}>
export type PortalPlugin = { activate(context: PluginContext): void | (() => void) }
export type PluginDefinition = Readonly<{
  id: string
  name: string
  description: string
  enabledByDefault: boolean
  placements: Readonly<Partial<Record<PortalRegion, boolean>>>
  load: () => Promise<PortalPlugin>
}>

export const createPortalRegistry = () => createSlotRegistry<PortalSlots>(portalRegions)
