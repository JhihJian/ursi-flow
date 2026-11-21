import { requestV2 } from '@/shared/http/client'

const path = '/platform-env'
export const listVariables = (signal: AbortSignal) => requestV2<string[]>(path, { signal })
export const createVariable = (name: string, value: string, signal: AbortSignal) =>
  requestV2<{ name: string }>(path, { method: 'POST', body: JSON.stringify({ name, value }), signal })
export const replaceVariable = (name: string, value: string, signal: AbortSignal) =>
  requestV2<{ name: string }>(`${path}/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }), signal })
export const deleteVariable = (name: string, signal: AbortSignal) =>
  requestV2<{ name: string }>(`${path}/${encodeURIComponent(name)}`, { method: 'DELETE', signal })
