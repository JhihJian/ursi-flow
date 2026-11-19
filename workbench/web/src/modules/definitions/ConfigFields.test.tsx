import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfigFields } from './ConfigFields'
import { normalizeConfigSchema, type ConfigValues } from './config'

const schema = normalizeConfigSchema({ fields: [
  { key: 'name', label: '名称', type: 'string', required: true },
  { key: 'endpoint', label: '地址', type: 'url' },
  { key: 'token', label: '令牌', type: 'secret' },
  { key: 'mode', label: '模式', type: 'enum', options: [{ value: 'fast', label: '快速' }, { value: 'safe', label: '安全' }] },
  { key: 'count', label: '次数', type: 'integer' },
  { key: 'ratio', label: '比例', type: 'number' },
  { key: 'enabled', label: '启用', type: 'boolean' },
  { key: 'package', label: '配置包', type: 'configPackage' },
] })

afterEach(cleanup)

it('按 schema 渲染八种控件，配置包只显示公开名称', async () => {
  const user = userEvent.setup()
  const values: ConfigValues = {}
  const onValueChange = vi.fn((key: string, value: ConfigValues[string] | undefined) => { if (value === undefined) delete values[key]; else values[key] = value })
  const onSecretChange = vi.fn()
  function Harness() {
    const [secrets, setSecrets] = useState<Record<string, string>>({})
    return <ConfigFields schema={schema} values={values} onValueChange={onValueChange} secrets={secrets} onSecretChange={(key, value) => { onSecretChange(key, value); setSecrets(old => ({ ...old, [key]: value })) }} packageChoices={[{ id: 'cfg-1', name: '审核配置' }]} />
  }
  render(<Harness />)

  expect(screen.getByRole('status')).toHaveTextContent('未配置')
  expect(screen.getByLabelText('名称 *')).toHaveAttribute('type', 'text')
  expect(screen.getByLabelText('地址')).toHaveAttribute('type', 'text')
  expect(screen.getByLabelText('令牌')).toHaveAttribute('type', 'password')
  expect(screen.getByLabelText('次数')).toHaveAttribute('type', 'number')
  expect(screen.getByLabelText('比例')).toHaveAttribute('type', 'number')
  expect(screen.getByLabelText('启用')).toHaveAttribute('type', 'checkbox')
  expect(screen.getByRole('option', { name: '审核配置' })).toBeVisible()
  expect(screen.queryByText('cfg-1')).toBeNull()

  await user.type(screen.getByLabelText('令牌'), 'private-value')
  expect(onSecretChange).toHaveBeenCalled()
  expect(screen.getByLabelText('令牌')).not.toHaveValue('')
  expect(screen.queryByText('private-value')).toBeNull()
  fireEvent.change(screen.getByLabelText('启用'), { target: { checked: true } })
})

it('已有 secret 只显示状态提示，不回显服务端值', () => {
  render(<ConfigFields schema={schema} values={{ name: 'agent' }} secretConfigured={{ token: true }} packageChoices={[]} onValueChange={vi.fn()} />)
  expect(screen.getByLabelText('令牌')).toHaveValue('')
  expect(screen.getByLabelText('令牌')).toHaveAttribute('placeholder', '已配置，重新填写以替换')
  expect(screen.getByRole('status')).toHaveTextContent('已配置')
})
