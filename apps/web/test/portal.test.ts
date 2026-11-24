import assert from 'node:assert/strict'
import test from 'node:test'
import { createSlotRegistry } from '../../../packages/ui-slots/src/registry.ts'
import { startPlugin, type PluginStatus } from '../src/plugin-runtime.ts'
import { parsePortalConfig } from '../src/portal-config.ts'
import type { PluginDefinition, PortalSlots } from '../src/portal-contract.ts'
import { webUrl } from '../src/project.ts'

const registry = () => createSlotRegistry<PortalSlots>(['home.entries', 'home.aside'])
const definition = (load: PluginDefinition['load']): PluginDefinition => ({
  id: 'demo', name: 'Demo', description: '', enabledByDefault: true, placements: ['home.entries'], load,
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

test('module timeout prevents late activation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const slots = registry()
  const status: PluginStatus[] = []
  let resolve: (plugin: Awaited<ReturnType<PluginDefinition['load']>>) => void = () => assert.fail('load did not run')
  startPlugin(definition(() => new Promise(done => { resolve = done })), slots, value => status.push(value), 20)
  t.mock.timers.tick(20)
  resolve({ activate() { assert.fail('timed-out plugin activated') } })
  await flush()
  assert.deepEqual(status, ['loading', 'load-timeout'])
})

const config = {
  schemaVersion: 1,
  revision: 'r7',
  page: { brand: 'ursi-flow', name: 'my-project', description: '', repository: '', placement: 'right' },
  plugins: { demo: true },
  workbenchUrl: '/workbench',
}

test('configuration validates its revision, page and known plugins and defaults missing flags to off', () => {
  const parse = (value: unknown) => parsePortalConfig(value, ['demo', 'extra'], 'https://portal.example')
  assert.deepEqual(parse(config).plugins, { demo: true, extra: false })
  assert.throws(() => parse({ ...config, revision: 'not valid' }), /修订号/)
  assert.throws(() => parse({ ...config, plugins: { demo: 'true' } }), /插件开关/)
  assert.throws(() => parse({ ...config, plugins: { remote: true } }), /插件开关/)
  assert.throws(() => parse({ ...config, workbenchUrl: 'workbench.example/path' }), /Workbench 地址/)
  assert.throws(() => parse({ ...config, page: { ...config.page, name: ' ' } }), /项目名称/)
})

test('entry links accept web URLs, not credentials or script schemes', () => {
  const origin = 'https://portal.example'
  assert.equal(webUrl('/work-items', origin), `${origin}/work-items`)
  assert.equal(webUrl('https://workbench.example/items', origin), 'https://workbench.example/items')
  assert.equal(webUrl('//another.example', origin), undefined)
  assert.equal(webUrl('/\\another.example', origin), undefined)
  assert.equal(webUrl('javascript:alert(1)', origin), undefined)
  assert.equal(webUrl('https://user:secret@portal.example', origin), undefined)
})
