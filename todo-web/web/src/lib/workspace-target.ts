/**
 * 工作台区域不实现具体业务，只按配置嵌入外部页面。
 * 配置放在 `public/workspace-config.json`，部署时替换即可，不需要重新构建。
 */

export interface WorkspaceTarget {
  /** 允许 HTTP(S) 地址或站内路径，其中可用 `{id}`、`{project}`、`{workspace}`、`{sessionId}` 占位。 */
  urlTemplate: string
  label: string
}

const CONFIG_PATH = '/workspace-config.json'
const MAX_URL = 2048

export function parseWorkspaceTarget(input: unknown): WorkspaceTarget | null {
  if (!input || typeof input !== 'object') return null
  const { urlTemplate, label } = input as Record<string, unknown>
  if (typeof urlTemplate !== 'string') return null
  const url = urlTemplate.trim()
  if (!url || url.length > MAX_URL) return null
  if (!/^(https?:\/\/|\/)/.test(url)) return null
  const text = typeof label === 'string' ? label.trim().slice(0, 64) : ''
  return { urlTemplate: url, label: text || 'Workspace' }
}

export interface WorkspacePlaceholders {
  id: string
  project: string | null
  workspace: string | null
  sessionId: string | null
}

export function resolveWorkspaceUrl(
  template: string,
  values: WorkspacePlaceholders,
): string {
  const encoded = {
    id: encodeURIComponent(values.id),
    project: encodeURIComponent(values.project ?? ''),
    workspace: encodeURIComponent(values.workspace ?? ''),
    sessionId: encodeURIComponent(values.sessionId ?? ''),
  }
  return template.replace(/\{(id|project|workspace|sessionId)\}/g, (_, key: keyof typeof encoded) => encoded[key])
}

export async function loadWorkspaceTarget(): Promise<WorkspaceTarget | null> {
  try {
    const response = await fetch(CONFIG_PATH, { cache: 'no-store' })
    if (!response.ok) return null
    return parseWorkspaceTarget(await response.json())
  } catch {
    return null
  }
}
