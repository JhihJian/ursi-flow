import { createContext, useContext } from 'react'

/**
 * 右键菜单的挂载容器：侧边栏根（.wsx-explorer），不滚动，两列列表共用。
 * 坐标相对它换算，菜单 portal 进它，不用全局 position: fixed。
 * 单独成文件避免 explorer ↔ tree / workspace-list 互相 import。
 */
const MenuContainerContext = createContext<HTMLElement | null>(null)

export const MenuContainerProvider = MenuContainerContext.Provider

export function useMenuContainer(): HTMLElement | null {
  return useContext(MenuContainerContext)
}
