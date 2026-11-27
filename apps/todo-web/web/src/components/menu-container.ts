import { createContext, useContext } from 'react'

/**
 * 工作区右键菜单的挂载容器：.todo-workspace 根，不滚动。
 * 坐标相对它换算，菜单 portal 进它，不用全局 position: fixed。
 * 单独成文件，避免 TodoWorkspace 与两个消费者互相 import。
 */
const MenuContainerContext = createContext<HTMLElement | null>(null)

export const MenuContainerProvider = MenuContainerContext.Provider

export function useMenuContainer(): HTMLElement | null {
  return useContext(MenuContainerContext)
}

/** 把视口坐标换成菜单容器坐标；容器未挂载时返回 null，调用方据此不开菜单。 */
export function toContainerPoint(
  container: HTMLElement | null,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!container) return null
  const rect = container.getBoundingClientRect()
  return { x: clientX - rect.left, y: clientY - rect.top }
}
