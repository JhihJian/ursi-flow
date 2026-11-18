// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { setApiTransport } from '@/shared/http/client'
import { useChatStore } from './store'
import { createChatTestServer, emptySession, sampleSession } from './testServer'
import { routes } from './routes'

function renderAt(entry: string) {
  const router = createMemoryRouter(routes, { initialEntries: [entry] })
  render(<RouterProvider router={router} />)
  return router
}

async function ready() {
  await screen.findByRole('heading', { level: 1, name: '对话' })
}

beforeEach(() => { useChatStore.setState(useChatStore.getInitialState(), true) })
afterEach(() => {
  cleanup()
  setApiTransport((...args) => globalThis.fetch(...args))
})

describe('对话页', () => {
  it('直接进入会话地址渲染历史消息、推理与工具折叠块', async () => {
    setApiTransport(createChatTestServer({ sessions: [sampleSession(), emptySession('chat-9', '支付重试排查')] }).fetch)
    renderAt('/chat/chat-1')
    await ready()

    expect(await screen.findByText('现在有哪些工作流和运行？')).toBeInTheDocument()
    // 会话列表与会话详情同时加载，列表不能被详情响应覆盖。
    const sidebar = screen.getByRole('complementary')
    expect(await within(sidebar).findByRole('button', { name: /^支付重试排查/ })).toBeInTheDocument()
    const strong = screen.getByText('3')
    expect(strong.tagName).toBe('STRONG')
    expect(screen.getByText('推理过程')).toBeInTheDocument()
    expect(screen.getByText(/工具调用 · 读取运行记录/)).toBeInTheDocument()
    expect(screen.getByText('共 3 条运行')).toBeInTheDocument()
  })

  it('输入消息并回车发送，流式中显示停止，结束后渲染 Markdown 回复', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    setApiTransport(createChatTestServer({ hold: () => gate }).fetch)
    renderAt('/chat/chat-1')
    await ready()

    const input = await screen.findByLabelText('输入消息')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()

    await userEvent.type(input, '支付重试逻辑怎么样？{Enter}')
    expect(await screen.findByRole('button', { name: '停止' })).toBeInTheDocument()
    const record = screen.getByRole('list', { name: '消息记录' })
    expect(within(record).getByText('第一段，')).toBeInTheDocument()

    release()
    await waitFor(() => { expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument() })
    const reply = await within(record).findByText('重点')
    expect(reply.tagName).toBe('STRONG')
    expect(within(record).getByText('支付重试逻辑怎么样？')).toBeInTheDocument()
  })

  it('未选择会话时显示空态，新建对话后进入会话地址', async () => {
    setApiTransport(createChatTestServer().fetch)
    const router = renderAt('/chat')
    await ready()

    expect(await screen.findByRole('heading', { level: 2, name: '开始一段新对话' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '新建对话' }))

    await waitFor(() => { expect(router.state.location.pathname).toMatch(/^\/chat\/chat-\d+$/) })
    const header = screen.getByRole('heading', { level: 2, name: '新对话' })
    expect(header).toBeInTheDocument()
  })

  it('搜索会话只保留匹配项，选中会话进入对应地址', async () => {
    setApiTransport(createChatTestServer({ sessions: [sampleSession(), emptySession('chat-9', '支付重试排查')] }).fetch)
    const router = renderAt('/chat')
    await ready()
    const sidebar = screen.getByRole('complementary')

    await userEvent.type(within(sidebar).getByLabelText('搜索会话'), '支付')
    expect(within(sidebar).queryByRole('button', { name: /^了解当前演示数据/ })).toBeNull()

    await userEvent.click(within(sidebar).getByRole('button', { name: /^支付重试排查/ }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/chat/chat-9') })
  })

  it('回到 /chat 时清空选中会话，不保留上次高亮', async () => {
    setApiTransport(createChatTestServer({ sessions: [sampleSession(), emptySession('chat-9', '支付重试排查')] }).fetch)
    const router = renderAt('/chat/chat-1')
    await ready()
    await waitFor(() => { expect(useChatStore.getState().currentId).toBe('chat-1') })

    await router.navigate('/chat')
    await waitFor(() => { expect(useChatStore.getState().currentId).toBeNull() })
    expect(screen.getByRole('heading', { level: 2, name: '开始一段新对话' })).toBeInTheDocument()
    expect(screen.getByRole('complementary').querySelector('[aria-current="true"]')).toBeNull()
  })

  it('错误条带重试入口，重发后清除错误', async () => {
    const server = createChatTestServer({ sessions: [sampleSession()] })
    let failing = 1
    setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/messages') && failing > 0) {
        failing -= 1
        return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '原始服务端文案' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return server.fetch(input, init)
    }) as typeof fetch)
    renderAt('/chat/chat-1')
    await ready()

    await userEvent.type(await screen.findByLabelText('输入消息'), '会失败的问题{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('服务暂时不可用，请重试。')
    expect(alert).not.toHaveTextContent('原始服务端文案')

    await userEvent.click(within(alert).getByRole('button', { name: '重新发送' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(server.calls.at(-1)).toMatchObject({ method: 'POST', url: '/chat/sessions/chat-1/messages', body: { text: '会失败的问题', regenerate: true } })
    expect(await screen.findByText('重点')).toBeInTheDocument()
  })

  it('会话列表加载失败时显示可重试错误，不显示空态', async () => {
    const server = createChatTestServer()
    let failing = 1
    setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/chat/sessions' && (init?.method ?? 'GET') === 'GET' && failing > 0) {
        failing -= 1
        return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return server.fetch(input, init)
    }) as typeof fetch)
    renderAt('/chat')
    await ready()
    const sidebar = screen.getByRole('complementary')

    expect(await within(sidebar).findByRole('alert')).toHaveTextContent('服务暂时不可用，请重试。')
    expect(within(sidebar).queryByText(/还没有会话/)).toBeNull()

    await userEvent.click(within(sidebar).getByRole('button', { name: '重新加载' }))
    expect(await within(sidebar).findByRole('button', { name: /^了解当前演示数据/ })).toBeInTheDocument()
    expect(within(sidebar).queryByRole('alert')).toBeNull()
  })

  it('离开页面时中止在途消息流', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    setApiTransport(createChatTestServer({ sessions: [sampleSession()], hold: () => gate }).fetch)
    renderAt('/chat/chat-1')
    await ready()

    await userEvent.type(await screen.findByLabelText('输入消息'), '在途问题{Enter}')
    await screen.findByRole('button', { name: '停止' })

    cleanup()
    await waitFor(() => { expect(useChatStore.getState().streaming).toBe(false) })
    expect(useChatStore.getState().error).toBe('')
    release()
  })
})
