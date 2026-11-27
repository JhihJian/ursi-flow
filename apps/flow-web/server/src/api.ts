import { readFile } from 'node:fs/promises'
import type http from 'node:http'
import { EngineError } from 'ursi-flow'
import type { FlowVariables } from 'ursi-flow'
import { FlowHomeError, pathsOf, readSettings, writeSettings } from './config.ts'
import { listFlows, readFlow } from './flows.ts'
import { readBody, sendError, sendJson } from './http-util.ts'
import { createRunService } from './runs.ts'

/**
 * 同源 API。路由按前缀与路径段精确匹配，不做模糊匹配，
 * 避免把 /api/runs/<id>/confirm 这类写操作误当成查询。
 */
export function createApiHandler(stateDir: string) {
  const runs = createRunService({ runsRoot: pathsOf(stateDir).runsRoot })
  const executorList = () =>
    runs.executors().map((adapter) => ({
      id: adapter.id,
      title: adapter.title,
      description: adapter.description,
    }))

  return async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!pathname.startsWith('/api/')) return false
    try {
      const method = req.method ?? 'GET'
      const segments = pathname.slice('/api/'.length).split('/').filter(Boolean)

      if (segments[0] === 'config' && segments.length === 1) {
        if (method === 'GET') {
          const settings = await readSettings(stateDir)
          sendJson(res, 200, {
            flowHome: settings.flowHome,
            stateDir,
            runsRoot: pathsOf(stateDir).runsRoot,
            executors: executorList(),
            defaultExecutor: runs.defaultExecutor(),
          })
          return true
        }
        if (method === 'PUT') {
          const body = await jsonBody(req)
          const flowHome = typeof body.flowHome === 'string' ? body.flowHome : ''
          if (flowHome.trim() === '') throw new HttpError(400, '缺少 flowHome')
          const settings = await writeSettings(stateDir, { flowHome })
          sendJson(res, 200, {
            flowHome: settings.flowHome,
            stateDir,
            runsRoot: pathsOf(stateDir).runsRoot,
            executors: executorList(),
            defaultExecutor: runs.defaultExecutor(),
          })
          return true
        }
        throw new HttpError(405, '不支持的方法')
      }

      if (segments[0] === 'flows') {
        const home = (await readSettings(stateDir)).flowHome
        if (segments.length === 1) {
          if (method !== 'GET') throw new HttpError(405, '不支持的方法')
          sendJson(res, 200, { flowHome: home, flows: await listFlows(home) })
          return true
        }
        if (segments.length === 2) {
          if (method !== 'GET') throw new HttpError(405, '不支持的方法')
          sendJson(res, 200, { flow: await readFlow(home, segments[1]) })
          return true
        }
        throw new HttpError(404, '接口不存在')
      }

      if (segments[0] === 'runs') {
        if (segments.length === 1) {
          if (method === 'GET') {
            const limit = Number(
              new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit') ??
                100,
            )
            sendJson(res, 200, {
              runs: await runs.list(Number.isFinite(limit) ? limit : 100),
            })
            return true
          }
          if (method !== 'POST') throw new HttpError(405, '不支持的方法')
          const body = await jsonBody(req)
          const flowId = typeof body.flowId === 'string' ? body.flowId : ''
          if (flowId === '') throw new HttpError(400, '缺少 flowId')
          const home = (await readSettings(stateDir)).flowHome
          const flow = await readFlow(home, flowId)
          if (!flow.valid) throw new HttpError(400, flow.error ?? 'Flow 不可执行')
          if (body.variables !== undefined && !isPlainObject(body.variables))
            throw new HttpError(400, 'variables 必须是对象')
          const { runId } = await runs.start({
            flow: { id: flow.id, text: await readFileText(flow.path), path: flow.path },
            variables: (body.variables as FlowVariables | undefined) ?? {},
            ...(typeof body.executor === 'string' && body.executor !== ''
              ? { executor: body.executor }
              : {}),
            ...(typeof body.cwd === 'string' && body.cwd !== ''
              ? { cwd: body.cwd }
              : {}),
          })
          sendJson(res, 202, { runId })
          return true
        }
        const runId = segments[1]
        if (segments.length === 2) {
          if (method !== 'GET') throw new HttpError(405, '不支持的方法')
          const view = await runs.view(runId)
          if (view === undefined) throw new HttpError(404, `运行不存在：${runId}`)
          sendJson(res, 200, { run: view })
          return true
        }
        if (segments.length === 3) {
          if (method !== 'POST') throw new HttpError(405, '不支持的方法')
          const body = await jsonBody(req)
          if (segments[2] === 'confirm') {
            const stepId = typeof body.stepId === 'string' ? body.stepId : ''
            const result = typeof body.result === 'string' ? body.result : ''
            if (stepId === '' || result === '')
              throw new HttpError(400, '确认需要 stepId 与 result')
            sendJson(res, 200, { run: await runs.confirm(runId, stepId, result) })
            return true
          }
          if (segments[2] === 'resume') {
            sendJson(res, 200, { run: await runs.resume(runId) })
            return true
          }
          if (segments[2] === 'stop') {
            const reason = typeof body.reason === 'string' ? body.reason : undefined
            sendJson(res, 200, { run: await runs.stop(runId, reason) })
            return true
          }
        }
        throw new HttpError(404, '接口不存在')
      }

      throw new HttpError(404, '接口不存在')
    } catch (error) {
      respondWithError(res, error)
      return true
    }
  }
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function respondWithError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendError(res, error.status, 'invalid', error.message)
    return
  }
  if (error instanceof FlowHomeError) {
    sendError(res, error.status, 'invalid', error.message)
    return
  }
  if (error instanceof EngineError) {
    const status =
      error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400
    sendError(res, status, error.code, error.message)
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendError(res, 500, 'internal', message)
}

async function jsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, 1024 * 1024)
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(400, '请求体不是有效 JSON')
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象')
  return parsed
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFileText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
