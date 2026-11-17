import { onBeforeUnmount } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { confirmAction } from './feedback'

export function useUnsavedChanges(isDirty: () => boolean) {
  async function canLeave() {
    return !isDirty() || await confirmAction({ title: '放弃未保存的更改？', description: '离开后，本次编辑的内容将不会保存。', confirmLabel: '放弃更改', danger: true })
  }
  onBeforeRouteLeave(canLeave)
  function beforeUnload(event: BeforeUnloadEvent) {
    if (isDirty()) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', beforeUnload)
  onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
  return { canLeave }
}
