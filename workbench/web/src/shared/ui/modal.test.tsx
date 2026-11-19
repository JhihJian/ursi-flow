// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Button } from './button'
import { Modal } from './modal'

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => { setOpen(true) }}>打开对话框</button>
      <Modal
        open={open}
        title="验收对话框"
        onClose={() => { setOpen(false) }}
        footer={<Button>保存</Button>}
      >
        <input aria-label="名称" />
        <Button>第一项</Button>
      </Modal>
    </>
  )
}

afterEach(() => { cleanup() })

describe('模态框焦点与关闭', () => {
  it('打开后约束焦点、Esc 关闭并恢复触发元素焦点', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '打开对话框' })
    trigger.focus()
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: '验收对话框' })
    await waitFor(() => { expect(dialog.contains(document.activeElement)).toBe(true) })

    for (let step = 0; step < 8; step += 1) await user.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)

    await user.keyboard('{Escape}')
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('关闭按钮与保存操作正常结束交互', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: '打开对话框' }))
    const dialog = await screen.findByRole('dialog', { name: '验收对话框' })

    expect(dialog).toContainElement(screen.getByRole('button', { name: '保存' }))
    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })
})
