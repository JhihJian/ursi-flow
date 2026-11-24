import type { PluginDefinition } from './portal-contract'

export type Placement = 'right' | 'below'
export type Preferences = { placement: Placement; plugins: Partial<Record<string, boolean>> }

export function readPreferences(raw: string | null, manifest: readonly PluginDefinition[]): Preferences {
  const defaults: Preferences = { placement: 'right', plugins: {} }
  try {
    const config = JSON.parse(raw ?? 'null')
    if (config?.version !== 1) return defaults
    const plugins = Object.fromEntries(manifest.flatMap(({ id }) => {
      const value = config.plugins?.[id]
      return typeof value === 'boolean' ? [[id, value]] : []
    }))
    return { placement: config.placement === 'below' ? 'below' : 'right', plugins }
  } catch {
    return defaults
  }
}

export const preferenceKey = (projectId: string) => `ursi.portal.v1:${projectId}`

export function readStoredPreferences(projectId: string, manifest: readonly PluginDefinition[]) {
  try { return readPreferences(localStorage.getItem(preferenceKey(projectId)), manifest) }
  catch { return readPreferences(null, manifest) }
}

export function writePreferences(projectId: string, preferences: Preferences) {
  try { localStorage.setItem(preferenceKey(projectId), JSON.stringify({ version: 1, ...preferences })) }
  catch { /* The current page still uses the selected settings. */ }
}
