import { ref } from 'vue'

export const toasts = ref<{ id: number; message: string; kind: 'success' | 'error' }[]>([])
let nextId = 0
export function notify(message: string, kind: 'success' | 'error' = 'success') {
  const id = ++nextId
  toasts.value.push({ id, message, kind })
  window.setTimeout(() => dismissToast(id), 4500)
}
export function dismissToast(id: number) { toasts.value = toasts.value.filter((toast) => toast.id !== id) }

export interface ConfirmOptions { title: string; description: string; danger?: boolean; confirmLabel?: string }
export const confirmation = ref<ConfirmOptions | null>(null)
let resolveConfirmation: ((value: boolean) => void) | undefined
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  resolveConfirmation?.(false)
  confirmation.value = options
  return new Promise((resolve) => { resolveConfirmation = resolve })
}
export function finishConfirmation(accepted: boolean) {
  confirmation.value = null
  resolveConfirmation?.(accepted)
  resolveConfirmation = undefined
}
