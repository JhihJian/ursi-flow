import { expect, it } from 'vitest'
import { createRequestIds } from './dispatch'

it('同一组参数换键序或对象身份仍复用同一标识', () => {
  const requestId = createRequestIds()
  const first = requestId({ package: 'triage', revision: 1, input: { ticket: 'A', meta: { a: 1, b: [1, 2] } } })
  const second = requestId({ input: { meta: { b: [1, 2], a: 1 }, ticket: 'A' }, revision: 1, package: 'triage' })
  expect(first).toMatch(/^[0-9a-f]{32}$/)
  expect(second).toBe(first)
})

it('改动参数值、数组顺序或标识本体都会换新标识', () => {
  const requestId = createRequestIds()
  const base = requestId({ revision: 1, input: { ticket: 'A', tags: ['x', 'y'] } })
  expect(requestId({ revision: 1, input: { ticket: 'B', tags: ['x', 'y'] } })).not.toBe(base)
  expect(requestId({ revision: 1, input: { ticket: 'A', tags: ['y', 'x'] } })).not.toBe(base)
  expect(requestId({ revision: 2, input: { ticket: 'A', tags: ['x', 'y'] } })).not.toBe(base)
})

it('不同表单的映射互不共享标识', () => {
  const parameters = { revision: 1, input: { ticket: 'A' } }
  expect(createRequestIds()(parameters)).not.toBe(createRequestIds()(parameters))
})
