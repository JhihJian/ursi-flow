import { createContext, useContext, type ReactNode } from 'react'
import { useStore, type StoreApi, type UseBoundStore } from 'zustand'
import { SshApi } from './api/client'
import type { TerminalEvent } from './terminal/bridge'
import { createSshStore, type SshStoreState, type TerminalState } from './store/ssh-store'

/** ssh-web 的一条运行实例：API 通道 + store。工厂创建，一页一个实例。 */
export interface SshController {
  api: SshApi
  store: UseBoundStore<StoreApi<SshStoreState>>
}

export interface SshControllerOptions {
  /** API 前缀。缺省 `/api`（独立入口）；嵌入工作区由宿主注入 `/api/ssh-web`。与 todo/fs 模块的字段名一致。 */
  apiBaseUrl?: string
  /** 亮暗主题 localStorage 键。缺省 `ssh.terminal-light`。 */
  storageKey?: string
}

export function createSshController(options: SshControllerOptions = {}): SshController {
  const api = new SshApi({ baseUrl: options.apiBaseUrl })
  const store = createSshStore({ api, storageKey: options.storageKey })
  return { api, store }
}

const ControllerContext = createContext<SshController | null>(null)

export function SshControllerProvider({
  controller,
  children,
}: {
  controller: SshController
  children?: ReactNode
}) {
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>
}

export function useSshController(): SshController {
  const controller = useContext(ControllerContext)
  if (!controller) throw new Error('ssh-web: 缺少 SshControllerProvider')
  return controller
}

/** 组件侧的 store 钩子：与模块级单例时代的 `useSshStore(selector)` 用法一致。 */
export function useSshStore<T>(selector: (state: SshStoreState) => T): T {
  const { store } = useSshController()
  return useStore(store, selector)
}

/** 模块根容器（.ssh-embed）：右键菜单的 portal 目标与绝对定位坐标系。 */
const ContainerContext = createContext<HTMLElement | null>(null)

export const SshContainerProvider = ContainerContext.Provider

export function useSshContainer(): HTMLElement | null {
  return useContext(ContainerContext)
}

/** 把 WS 事件映射到 store 的终端生命周期：closed 事件即 ended，不是卸载。 */
export function terminalStateTo(event: TerminalEvent): TerminalState {
  return event.kind === 'error' ? 'error' : 'ended'
}
