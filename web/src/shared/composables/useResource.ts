import { onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { errorMessage } from '@/shared/api'

export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>, initial: T) {
  const data = shallowRef<T>(initial)
  const loading = ref(true)
  const error = ref('')
  let controller: AbortController | undefined
  let generation = 0
  async function load() {
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = ''
    try {
      const result = await loader(controller.signal)
      if (current === generation) data.value = result
    } catch (cause) {
      if (current === generation && !controller.signal.aborted) error.value = errorMessage(cause)
    } finally {
      if (current === generation) loading.value = false
    }
  }
  onMounted(() => { void load() })
  onScopeDispose(() => { generation++; controller?.abort() })
  return { data, loading, error, load }
}
