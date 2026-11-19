import { createElement } from 'react'
import { render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { vi } from 'vitest'
import { setToken } from '@/shared/http/session'
import type { WorkspaceAttempt, WorkspaceDetail, WorkspaceSop } from './model'
import { workspaceRoutes } from './routes'

export type Serve = (path: string, options: RequestInit) => Response | Promise<Response>
export type Call = { path: string; options: RequestInit }

/** 以真实路由和共享客户端挂载工作包模块，只有 fetch 被替换。 */
export function mountWorkspace(path: string, serve: Serve) {
  setToken('demo-token')
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    const clean = String(url).replace('/api/v2', '')
    calls.push({ path: clean, options })
    return serve(clean, options)
  }))
  const router = createMemoryRouter(workspaceRoutes, { initialEntries: [path] })
  render(createElement(RouterProvider, { router }))
  return { router, calls }
}

export const roleFinding = { id: 'finding', label: 'Finding' }
export const roleSource = { id: 'source', label: '源码包' }
export const sopV1: WorkspaceSop = {
  id: 'receipt',
  revision: 1,
  executor: 'echo',
  config: { title: '材料接收回执' },
}
export const sopV2: WorkspaceSop = {
  id: 'receipt',
  revision: 2,
  executor: 'echo',
  config: { title: '项目交接记录' },
}
export const findingType = {
  id: 'finding-report',
  name: '单条线索报告',
  roles: [roleFinding, roleSource],
  sop: { id: sopV1.id, revision: sopV1.revision },
}

export function attempt(patch: Partial<WorkspaceAttempt> = {}): WorkspaceAttempt {
  return { id: 'attempt-1', status: 'succeeded', sop: sopV1, ...patch }
}

export function detail(patch: Partial<WorkspaceDetail> = {}): WorkspaceDetail {
  return {
    id: 'W-1',
    typeId: 'finding-report',
    requirement: '排查线索 A',
    frozen: false,
    roles: [roleFinding, roleSource],
    materials: [],
    attempts: [],
    ...patch,
  }
}

export function json(value: unknown, init?: ResponseInit) {
  return Response.json(value, init)
}

export function text(value: string) {
  return new Response(value, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
