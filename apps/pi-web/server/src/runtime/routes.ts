import { readFile } from 'node:fs/promises'
import { HANDLED, route } from '../http/router.ts'
import { HomeError } from '../shared/pi-home.ts'
import { replay } from '../facts/replay.ts'
import { getEntity, project } from '../sessions/registry.ts'
import {
  abortChat,
  answerUiRequest,
  attachChatStream,
  closeChat,
  getChat,
  liveChat,
  promptChat,
  setChatModel,
} from './chat.ts'
import { liveFactsText, projectLiveFacts } from './facts.ts'
import { abortSessionTask } from './session-task.ts'

/**
 * 运行时域路由：这些接口都作用在「活的会话运行时」上。
 *
 * 装配、发消息、中止、交互回执、模型切换、释放、事件流都归这里；会话清单、
 * 轨迹文件、删除与偏好在 `sessions/`。两边共用 `sessions/registry.ts` 的实体表：
 * 动作前一律先按 id 取实体，动作前后写回的也是同一份实体。
 *
 * 路由只声明 `none` 策略：home 是会话实体的属性，不由请求参数决定。
 */

function requireEntity(id: string) {
  const entity = getEntity(id)
  if (!entity) throw new HomeError(`没有这个会话：${id}`, 404, 'session_absent')
  return entity
}

/** 没有本地运行时的统一报错：与轨迹、事件流、中止三个入口同一个 code。 */
function notLocal(id: string): HomeError {
  return new HomeError(`该会话没有本地运行时：${id}`, 409, 'session_not_local')
}

/** 事件流：只有存在本地运行时的会话有增量；其它会话由客户端轮询集合。 */
route('GET', '/api/sessions/:id/events', 'none', async ({ params, req, res }) => {
  const entity = requireEntity(params.id)
  if (!entity.runtimes.some((fact) => fact.origin === 'local')) throw notLocal(entity.id)
  attachChatStream(entity.id, req, res)
  return HANDLED
})

route('POST', '/api/sessions/:id/turn', 'none', async ({ params, body, res }) => {
  const entity = requireEntity(params.id)
  if (entity.state === 'loading') throw new HomeError('会话正在装配，稍后再试', 409, 'session_loading')
  const payload = await body<{ text?: unknown; mode?: unknown }>()
  if (typeof payload.text !== 'string') throw new HomeError('text 必填', 400, 'invalid_request')
  const result = await promptChat(
    entity.id,
    payload.text,
    payload.mode === 'steer' ? 'steer' : 'followUp',
  )
  const updated = getEntity(entity.id)
  res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ ...result, session: updated ? project(updated) : null }))
  return HANDLED
})

/**
 * 中止：一次性任务与对话共用这一个入口。
 *
 * 先看有没有运行中的任务（任务只在运行时可取消），没有任务再交给对话运行时；
 * 两者都没有说明这条会话在本进程里没有运行时，报 409 而不是 404。
 */
route('POST', '/api/sessions/:id/abort', 'none', async ({ params }) => {
  const entity = requireEntity(params.id)
  if (abortSessionTask(entity.id)) return { steering: [], followUp: [] }
  if (!getChat(entity.id)) throw notLocal(entity.id)
  return abortChat(entity.id)
})

route('POST', '/api/sessions/:id/interaction', 'none', async ({ params, body }) => {
  requireEntity(params.id)
  const payload = await body<{ interactionId?: unknown; requestId?: unknown; value?: unknown }>()
  const requestId = payload.interactionId ?? payload.requestId
  if (typeof requestId !== 'string' || !requestId) {
    throw new HomeError('interactionId 必填', 400, 'invalid_request')
  }
  answerUiRequest(params.id, requestId, payload.value)
  return { ok: true }
})

route('POST', '/api/sessions/:id/model', 'none', async ({ params, body }) => {
  const entity = requireEntity(params.id)
  if (entity.state === 'loading') throw new HomeError('会话正在装配，稍后再试', 409, 'session_loading')
  const payload = await body<{ provider?: unknown; modelId?: unknown; thinkingLevel?: unknown }>()
  if (typeof payload.provider !== 'string' || !payload.provider.trim()) {
    throw new HomeError('provider 必填', 400, 'invalid_request')
  }
  return setChatModel(
    entity.id,
    payload.provider.trim(),
    typeof payload.modelId === 'string' && payload.modelId.trim() ? payload.modelId.trim() : undefined,
    typeof payload.thinkingLevel === 'string' && payload.thinkingLevel.trim()
      ? payload.thinkingLevel.trim()
      : undefined,
  )
})

route('POST', '/api/sessions/:id/evict', 'none', async ({ params }) => {
  requireEntity(params.id)
  await closeChat(params.id)
  return { ok: true }
})

/**
 * 运行事实：有本地运行时由运行时直接投影（模型、工具以运行时为准），
 * 否则重放会话文件；两样都没有就没什么可说。
 */
route('GET', '/api/sessions/:id/facts', 'none', async ({ params }) => {
  const entity = requireEntity(params.id)
  const chat = liveChat(entity.id)
  if (chat) return projectLiveFacts(chat, liveFactsText(chat))
  if (entity.filePath) {
    let text: string
    try {
      text = await readFile(entity.filePath, 'utf8')
    } catch (error) {
      // 实体还挂着文件但文件已被外部删除：按会话缺失报，不落 500。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HomeError(`会话文件不存在：${entity.filePath}`, 404, 'session_absent')
      }
      throw error
    }
    return replay(text)
  }
  throw notLocal(entity.id)
})
