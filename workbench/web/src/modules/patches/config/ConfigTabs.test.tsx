import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConfigTabs } from './ConfigTabs'

afterEach(() => { cleanup() })

const tabs = [
  { id: 'prompt' as const, label: '系统提示词' },
  { id: 'skills' as const, label: 'Skills', count: 2 },
  { id: 'mcp' as const, label: 'MCP' },
]

describe('紧凑分区标签', () => {
  it('标出当前分区，计数为 0 时不显示', () => {
    render(<ConfigTabs tabs={tabs} value="skills" onChange={() => {}} ariaLabel="配置补丁分区" />)
    expect(screen.getByRole('tab', { name: /Skills/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Skills/ }).textContent).toContain('2')
    expect(screen.getByRole('tab', { name: '系统提示词' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: /Skills/ })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'MCP' })).toHaveAttribute('tabindex', '-1')
  })

  it('点击与方向键、Home/End 都只切换分区', () => {
    const onChange = vi.fn()
    render(<ConfigTabs tabs={tabs} value="prompt" onChange={onChange} ariaLabel="配置补丁分区" />)
    const list = screen.getByRole('tablist', { name: '配置补丁分区' })

    fireEvent.click(screen.getByRole('tab', { name: 'MCP' }))
    expect(onChange).toHaveBeenLastCalledWith('mcp')

    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('skills')
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('mcp')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('prompt')
    fireEvent.keyDown(list, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('mcp')
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(onChange).toHaveBeenCalledTimes(5)
  })
})
