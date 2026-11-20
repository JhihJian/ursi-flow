import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText } from './clipboard'

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

afterEach(() => { Reflect.deleteProperty(navigator, 'clipboard'); vi.restoreAllMocks() })

describe('复制文本', () => {
  it('安全上下文优先使用异步剪贴板，不触碰临时文本域', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    expect(await copyText('memo:a')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('memo:a')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('局域网 HTTP 没有 Clipboard API 时用选区兜底并清理临时节点', async () => {
    setClipboard(undefined)
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    expect(await copyText('memo:a')).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('异步剪贴板被拒绝时改用兜底', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    expect(await copyText('memo:a')).toBe(true)
    expect(execCommand).toHaveBeenCalled()
  })

  it('两种方式都不可用时返回失败，由调用方提示手动复制', async () => {
    setClipboard(undefined)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    expect(await copyText('memo:a')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
