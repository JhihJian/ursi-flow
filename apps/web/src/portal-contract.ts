import { createSlotRegistry, type SlotRegistry } from '@ursi/ui-slots'
import type { ProjectInfo } from './project'

export type PortalContext = Readonly<{ project: ProjectInfo; workbenchUrl?: string }>
export type PortalSlots = { 'home.entries': PortalContext; 'home.aside': PortalContext }
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
  load: () => Promise<PortalPlugin>
}>

export const createPortalRegistry = () => createSlotRegistry<PortalSlots>(['home.entries', 'home.aside'])
