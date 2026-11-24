import assert from 'node:assert/strict'
import test from 'node:test'
import { createSlotRegistry } from '../../../packages/ui-slots/src/registry.ts'
import { startPlugin, type PluginStatus } from '../src/plugin-runtime.ts'
import { parsePortalConfig } from '../src/portal-config.ts'
import type { PluginDefinition, PortalSlots } from '../src/portal-contract.ts'
import { webUrl } from '../src/project.ts'
import { portalRegions } from '../src/portal-regions.ts'

const registry = () => createSlotRegistry<PortalSlots>(portalRegions)
const definition = (load: PluginDefinition['load']): PluginDefinition => ({
  id: 'demo', name: 'Demo', description: '', enabledByDefault: true, placements: { 'left-top': true, right: true }, load,
})
const flush = () => new Promise(resolve => setImmediate(resolve))
const Empty = () => null

test('unmount removes the contributions and leaves a different plugin active', async () => {
  const slots = registry()
  const status: PluginStatus[] = []
  let disposed = false
  slots.register('left-top', { id: 'other', Component: Empty })
  const stop = startPlugin(definition(async () => ({ activate({ slots }) {
    slots.register('left-top', { id: 'entry', Component: Empty })
    slots.register('right', { id: 'aside', Component: Empty })
    return () => { disposed = true }
  } })), slots, value => status.push(value))
  await flush()
  assert.deepEqual(status, ['loading', 'ready'])
  assert.equal(slots.entries('right').length, 1)
  stop()
  assert.deepEqual(slots.entries('left-top').map(entry => entry.id), ['other'])
  assert.equal(slots.entries('right').length, 0)
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

test('registration into an undeclared region fails and rolls back earlier contributions', async t => {
  t.mock.method(console, 'error', () => {})
  const slots = registry()
  const status: PluginStatus[] = []
  startPlugin(definition(async () => ({ activate({ slots }) {
    slots.register('left-top', { id: 'entry', Component: Empty })
    slots.register('status', { id: 'undeclared', Component: Empty })
  } })), slots, value => status.push(value))
  await flush()
  assert.equal(slots.entries('left-top').length, 0)
  assert.equal(slots.entries('status').length, 0)
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
  schemaVersion: 2,
  revision: 'r7',
  page: { brand: 'ursi-flow', name: 'my-project', description: '', repository: '' },
  plugins: { demo: { enabled: true, regions: { 'left-top': true } } },
  workbenchUrl: '/workbench',
}

test('configuration validates its revision, page and known plugins and defaults missing flags to off', () => {
  const parse = (value: unknown) => parsePortalConfig(value, [
    { id: 'demo', placements: { 'left-top': true, right: true } },
    { id: 'extra', placements: { title: true } },
  ], 'https://portal.example')
  assert.deepEqual(parse(config).plugins, {
    demo: { enabled: true, regions: { 'left-top': true, right: false } }, extra: { enabled: false, regions: { title: false } },
  })
  assert.throws(() => parse({ ...config, schemaVersion: 1 }), /配置版本/)
  assert.throws(() => parse({ ...config, plugins: { demo: { enabled: true, regions: { status: true } } } }), /区域配置/)
  assert.throws(() => parse({ ...config, plugins: { demo: { enabled: true, regions: { right: 'yes' } } } }), /区域配置/)
  assert.throws(() => parse({ ...config, revision: 'not valid' }), /修订号/)
  assert.throws(() => parse({ ...config, plugins: { demo: 'true' } }), /开关无效/)
  assert.throws(() => parse({ ...config, plugins: { remote: true } }), /未登记的插件/)
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
