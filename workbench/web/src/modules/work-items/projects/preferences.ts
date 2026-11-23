export type Preferences = { pinned: string[]; recent?: { projectId: string; path: string } }
const key = 'workbench-project-preferences'

export function readPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}')
    const recent = stored.recent
    return {
      pinned: Array.isArray(stored.pinned) ? stored.pinned.filter((id: unknown) => typeof id === 'string') : [],
      recent: typeof recent?.projectId === 'string' && typeof recent.path === 'string' &&
        recent.path.startsWith(`/work-projects/${encodeURIComponent(recent.projectId)}/`) ? recent : undefined,
    }
  } catch { return { pinned: [] } }
}
export function writePreferences(value: Preferences) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Optional browser preference. */ }
}
