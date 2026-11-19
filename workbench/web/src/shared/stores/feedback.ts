import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  kind: 'success' | 'error'
}

export interface ConfirmOptions {
  title: string
  description: string
  danger?: boolean
  confirmLabel?: string
}

export interface FeedbackState {
  toasts: Toast[]
  confirmation: ConfirmOptions | null
  /** 展示一条通知并在 4.5 秒后自动关闭。 */
  notify: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  /** 打开确认弹窗，用户选择后由 finishConfirmation 结束等待。 */
  confirmAction: (options: ConfirmOptions) => Promise<boolean>
  finishConfirmation: (accepted: boolean) => void
}

const TOAST_TIMEOUT = 4500
let nextToastId = 0
let resolveConfirmation: ((accepted: boolean) => void) | undefined

/** 全局通知与确认状态，由应用壳呈现，业务域只发起请求。 */
export const useFeedbackStore = create<FeedbackState>((set, get) => ({
  toasts: [],
  confirmation: null,
  notify: (message, kind = 'success') => {
    const id = ++nextToastId
    set((state) => ({ toasts: [...state.toasts, { id, message, kind }] }))
    window.setTimeout(() => { get().dismissToast(id) }, TOAST_TIMEOUT)
  },
  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },
  confirmAction: (options) => {
    resolveConfirmation?.(false)
    set({ confirmation: options })
    return new Promise<boolean>((resolve) => { resolveConfirmation = resolve })
  },
  finishConfirmation: (accepted) => {
    set({ confirmation: null })
    resolveConfirmation?.(accepted)
    resolveConfirmation = undefined
  },
}))

/** 非组件环境下的便捷入口，行为与 store 方法一致。 */
export const notify = (message: string, kind?: Toast['kind']) => useFeedbackStore.getState().notify(message, kind)
export const dismissToast = (id: number) => useFeedbackStore.getState().dismissToast(id)
export const confirmAction = (options: ConfirmOptions) => useFeedbackStore.getState().confirmAction(options)
export const finishConfirmation = (accepted: boolean) => useFeedbackStore.getState().finishConfirmation(accepted)
