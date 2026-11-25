import { createContext, useContext } from 'react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 浮层挂载容器的 React context：值由 <AppRoot> 用 ref 提供。
 * Radix Portal 用它把 Dialog / Dropdown / AlertDialog 挂回模块根节点
 * （模块契约要求不写固定定位）。
 */
export const OverlayContainerContext = createContext<HTMLElement | null>(null)

/** Radix Popper 的 absolute 定位基准是最近的定位祖先；指向模块根节点后，滚动补偿也随容器滚动。 */
export function useOverlayContainer(): HTMLElement | null {
  return useContext(OverlayContainerContext)
}

/** 容器内居中的绝对定位（Radix 弹窗内容用）。 */
export const overlayCenteredClass =
  'absolute left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2'
