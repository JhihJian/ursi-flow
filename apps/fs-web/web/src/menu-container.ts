import { createContext, useContext } from 'react'

/**
 * 浮层（右键菜单、git 栏弹层）的挂载容器：侧边栏根（.wsx-explorer），不滚动。
 * 坐标相对它换算，菜单 portal 进它，不用全局 position: fixed。
 * 单独成文件，避免 explorer 与它的消费者（tree / workspace-list / git-popover）互相 import。
 */
const MenuContainerContext = createContext<HTMLElement | null>(null)

export const MenuContainerProvider = MenuContainerContext.Provider

export function useMenuContainer(): HTMLElement | null {
  return useContext(MenuContainerContext)
}
