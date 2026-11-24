export type ProjectInfo = Readonly<{
  brand: string
  id: string
  name: string
  description: string
  repository?: string
}>

export function webUrl(value: string | undefined, origin: string): string | undefined {
  const input = value?.trim()
  if (!input || /[\\\u0000-\u0020\u007f]/.test(input) || !/^(https?:\/\/[^/]|\/(?!\/))/i.test(input)) return undefined
  try {
    const url = new URL(input, origin)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) return url.href
  } catch { /* A malformed deployment value leaves the entry unconfigured. */ }
}

export function readProject(env: ImportMetaEnv, location: Location) {
  const project: ProjectInfo = {
    brand: env.VITE_BRAND_NAME?.trim().slice(0, 64) || 'ursi-flow',
    id: env.VITE_PROJECT_ID?.trim() || 'ursi-flow',
    name: env.VITE_PROJECT_NAME?.trim().slice(0, 100) || 'ursi-flow',
    description: env.VITE_PROJECT_DESCRIPTION?.trim().slice(0, 1200) || '流程、工作项与执行记录',
    repository: webUrl(env.VITE_PROJECT_REPOSITORY ?? 'https://github.com/JhihJian/ursi-flow', location.origin),
  }
  return { project, workbenchUrl: webUrl(env.VITE_WORKBENCH_URL, location.origin) }
}
