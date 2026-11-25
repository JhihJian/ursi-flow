import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 浮层挂回 .sbx-app 容器（模块契约要求不写 position: fixed）。
 * Radix Popper 的 absolute 定位基准是最近的定位祖先，直接挂在触发处
 * 会被表格等 overflow 容器裁剪；指向模块根节点后，滚动补偿也随容器滚动。
 */
export function appOverlayContainer(): HTMLElement | undefined {
  const app = document.querySelector('.sbx-app')
  return app instanceof HTMLElement ? app : undefined
}

/** 容器内居中的绝对定位（Radix 弹窗内容用）。 */
export const overlayCenteredClass =
  'absolute left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2'
