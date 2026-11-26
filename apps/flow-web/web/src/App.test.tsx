import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from './App'

/**
 * 独立入口的渲染冒烟：不连后端时只跑首屏，
 * 用来兜住「组件引错、Provider 缺失」这类一打开就白屏的问题。
 */
describe('独立入口', () => {
  it('空状态渲染出侧边栏与工作区提示', () => {
    const html = renderToString(<App apiBaseUrl="/api" />)
    expect(html).toContain('flow home')
    expect(html).toContain('Flow 包')
    expect(html).toContain('未选择 Flow')
  })
})
