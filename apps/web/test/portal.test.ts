import assert from 'node:assert/strict'
import test from 'node:test'
import { createSlotRegistry } from '../../../packages/ui-slots/src/registry.ts'
import { startPlugin, type PluginStatus } from '../src/plugin-runtime.ts'
import { readPreferences } from '../src/preferences.ts'
import type { PluginDefinition, PortalSlots } from '../src/portal-contract.ts'
import { webUrl } from '../src/project.ts'

const registry = () => createSlotRegistry<PortalSlots>(['home.entries', 'home.aside'])
const definition = (load: PluginDefinition['load']): PluginDefinition => ({
  id: 'demo', name: 'Demo', description: '', enabledByDefault: true, load,
})
const flush = () => new Promise(resolve => setImmediate(resolve))
const Empty = () => null

test('unmount removes the contributions and leaves a different plugin active', async () => {
  const slots = registry()
  const status: PluginStatus[] = []
  let disposed = false
  slots.register('home.entries', { id: 'other', Component: Empty })
  const stop = startPlugin(definition(async () => ({ activate({ slots }) {
    slots.register('home.entries', { id: 'entry', Component: Empty })
    slots.register('home.aside', { id: 'aside', Component: Empty })
    return () => { disposed = true }
  } })), slots, value => status.push(value))
  await flush()
  assert.deepEqual(status, ['loading', 'ready'])
  assert.equal(slots.entries('home.aside').length, 1)
  stop()
  assert.deepEqual(slots.entries('home.entries').map(entry => entry.id), ['other'])
  assert.equal(slots.entries('home.aside').length, 0)
  assert.equal(disposed, true)
})

test('late module resolution after disable never activates', async () => {
  const slots = registry()
  const status: PluginStatus[] = []
  let activated = false
  const stop = startPlugin(definition(async () => ({ activate() { activated = true } })), slots, value => status.push(value))
  stop()
  await flush()
  assert.equal(activated, false)
  assert.deepEqual(status, ['loading'])
})

test('failed activation rolls back its partial contributions', async t => {
  t.mock.method(console, 'error', () => {})
  const slots = registry()
  const status: PluginStatus[] = []
  startPlugin(definition(async () => ({ activate({ slots }) {
    slots.register('home.entries', { id: 'entry', Component: Empty })
    throw new Error('Demo failure')
  } })), slots, value => status.push(value))
  await flush()
  assert.equal(slots.entries('home.entries').length, 0)
  assert.deepEqual(status, ['loading', 'activation-failed'])
})

test('preferences restore known flags, reject malformed values and fall back to defaults', () => {
  const manifest = [definition(async () => ({ activate() {} }))]
  assert.deepEqual(readPreferences('{', manifest), { placement: 'right', plugins: {} })
  assert.deepEqual(readPreferences('{"version":1,"placement":"below","plugins":{"demo":false,"unknown":true}}', manifest), {
    placement: 'below', plugins: { demo: false },
  })
  assert.deepEqual(readPreferences('{"version":1,"placement":12,"plugins":{"demo":1}}', manifest), {
    placement: 'right', plugins: {},
  })
})

test('entry links accept web URLs, not credentials or script schemes', () => {
  const origin = 'https://portal.example'
  assert.equal(webUrl('/work-items', origin), `${origin}/work-items`)
  assert.equal(webUrl('javascript:alert(1)', origin), undefined)
  assert.equal(webUrl('https://user:secret@portal.example', origin), undefined)
})
