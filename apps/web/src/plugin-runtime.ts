import type { SlotRegistry } from '@ursi/ui-slots'
import type { PluginDefinition, PortalSlots } from './portal-contract'

export type PluginStatus = 'loading' | 'ready' | 'load-failed' | 'activation-failed'

export function startPlugin(
  definition: PluginDefinition,
  registry: SlotRegistry<PortalSlots>,
  status: (state: PluginStatus) => void,
) {
  const controller = new AbortController()
  const { signal } = controller
  const removals: (() => void)[] = []
  let dispose: void | (() => void)
  const stop = () => {
    if (signal.aborted) return
    controller.abort()
    try { dispose?.() } catch (error) { console.error('Plugin cleanup failed', definition.id, error) }
    finally { for (const remove of removals.reverse()) remove() }
  }

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
    try {
      dispose = plugin.activate({
        signal,
        slots: {
          register(slot, contribution) {
            if (signal.aborted) return () => {}
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
