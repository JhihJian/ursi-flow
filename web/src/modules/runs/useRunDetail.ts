import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { api } from '@/shared/api'
import type { Artifact, Run } from '@/shared/api/types'
import { isTerminal, mergeEvents, runErrorMessage, type NumberedEvent } from './runState'

export function useRunDetail(getId: () => string) {
  const run = shallowRef<Run | null>(null)
  const events = shallowRef<NumberedEvent[]>([])
  const artifacts = shallowRef<Artifact[]>([])
  const loading = ref(true)
  const refreshing = ref(false)
  const error = ref('')
  const artifactError = ref('')
  const actionError = ref('')
  const saving = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let pending: Promise<void> | undefined
  let generation = 0
  let disposed = false
  let artifactRevision = ''
  function clearTimer() { if (timer !== undefined) { clearTimeout(timer); timer = undefined } }
  function schedule() {
    clearTimer()
    if (!disposed && !saving.value && (!run.value || !isTerminal(run.value.status))) timer = setTimeout(() => { void load() }, 1500)
  }
  function accept(value: Run) { run.value = value; events.value = mergeEvents(events.value, value.events) }
  function load(forceArtifacts = false): Promise<void> {
    if (disposed || saving.value) return Promise.resolve()
    if (pending) return pending
    clearTimer()
    const current = generation
    const id = getId()
    const request = new AbortController()
    controller = request
    refreshing.value = true
    pending = (async () => {
      try {
        const result = await api.get<Run>(`/runs/${encodeURIComponent(id)}`, request.signal)
        if (disposed || current !== generation) return
        accept(result); error.value = ''
        if (forceArtifacts || artifactRevision !== result.updatedAt || artifactError.value) {
          try {
            const values = await api.get<Artifact[]>(`/artifacts?runId=${encodeURIComponent(id)}`, request.signal)
            if (disposed || current !== generation) return
            artifacts.value = values; artifactError.value = ''; artifactRevision = result.updatedAt
          } catch (cause) {
            if (!request.signal.aborted && current === generation) artifactError.value = runErrorMessage(cause)
          }
        }
      } catch (cause) {
        if (!request.signal.aborted && current === generation) error.value = runErrorMessage(cause)
      } finally {
        if (current === generation && !disposed) {
          loading.value = false; refreshing.value = false; pending = undefined
          schedule()
        }
      }
    })()
    return pending
  }
  async function act(action: 'approve' | 'reject' | 'cancel', body: Record<string, string> = {}) {
    if (saving.value || disposed) return false
    saving.value = true; actionError.value = ''; clearTimer()
    const current = generation
    const id = getId()
    try {
      // Finish the active read before mutating, so an older response cannot overwrite the action.
      await pending
      if (disposed || current !== generation) return false
      const result = await api.post<Run>(`/runs/${encodeURIComponent(id)}/${action}`, body)
      if (disposed || current !== generation) return false
      accept(result); error.value = ''; artifactRevision = ''
      return true
    } catch (cause) {
      if (!disposed && current === generation) actionError.value = runErrorMessage(cause)
      return false
    } finally {
      if (!disposed && current === generation) { saving.value = false; void load(true) }
    }
  }
  watch(getId, () => {
    generation++; clearTimer(); controller?.abort(); pending = undefined
    run.value = null; events.value = []; artifacts.value = []; artifactRevision = ''
    loading.value = true; refreshing.value = false; error.value = ''; artifactError.value = ''; actionError.value = ''; saving.value = false
    void load()
  }, { immediate: true })
  onBeforeUnmount(() => { disposed = true; generation++; clearTimer(); controller?.abort() })
  return { run, events, artifacts, loading, refreshing, error, artifactError, actionError, saving, load, act }
}
