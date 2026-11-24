export interface SessionMeta {
  id: string
  project: string | null
  projectDir: string
  size: number
  mtime: number
  format: 'pi' | 'claude-code' | 'unknown'
  candidates: string[]
  tooLarge: boolean
}

export class RequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'RequestError'
    this.status = status
  }
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new RequestError(body?.error ?? `HTTP ${response.status}`, response.status)
  }
  return (await response.json()) as T
}

export function fetchMeta(id: string): Promise<SessionMeta> {
  return readJson<SessionMeta>(`/api/sessions/${encodeURIComponent(id)}`)
}

export async function fetchSessionText(id: string): Promise<string> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/text`)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new RequestError(body?.error ?? `HTTP ${response.status}`, response.status)
  }
  return response.text()
}
