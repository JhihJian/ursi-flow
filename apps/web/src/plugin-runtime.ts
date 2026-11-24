import type { SlotRegistry } from '@ursi/ui-slots'
import type { PluginDefinition, PortalSlots } from './portal-contract'

export type PluginStatus = 'loading' | 'ready' | 'load-failed' | 'load-timeout' | 'activation-failed' | 'render-failed'

export function startPlugin(
  definition: PluginDefinition,
  registry: SlotRegistry<PortalSlots>,
  status: (state: PluginStatus) => void,
  timeoutMs = 8000,
) {
  const controller = new AbortController()
  const { signal } = controller
  const removals: (() => void)[] = []
  let dispose: void | (() => void)
  const stop = () => {
    if (signal.aborted) return
    clearTimeout(deadline)
    controller.abort()
    try { dispose?.() } catch (error) { console.error('Plugin cleanup failed', definition.id, error) }
    finally { for (const remove of removals.reverse()) remove() }
  }

  const deadline = setTimeout(() => {
    stop()
    status('load-timeout')
  }, timeoutMs)
  status('loading')
  void (async () => {
    let plugin
    try {
      plugin = await definition.load()
    } catch (error) {
      if (signal.aborted) return
      stop()
      console.error('Plugin module load failed', definition.id, error)
      status('load-failed')
      return
    }

    if (signal.aborted) return
    clearTimeout(deadline)
    try {
      dispose = plugin.activate({
        signal,
        slots: {
          register(slot, contribution) {
            if (signal.aborted) return () => {}
            if (!Object.hasOwn(definition.placements, slot)) throw new Error(`Plugin ${definition.id} did not declare region ${slot}`)
            const remove = registry.register(slot, { ...contribution, id: `${definition.id}/${contribution.id}` })
            removals.push(remove)
            return remove
          },
        },
      })
      status('ready')
    } catch (error) {
      if (signal.aborted) return
      stop()
      console.error('Plugin activation failed', definition.id, error)
      status('activation-failed')
    }
  })()
  return stop
}
