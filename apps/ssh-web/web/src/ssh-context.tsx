import { createContext, useContext, useEffect, type ReactNode } from 'react'
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

/**
 * 模块 Provider：一个 controller + 一次连接列表加载，侧边栏与工作区共用。
 * 必须是纯上下文组件，不能渲染布局 DOM。
 */
export function SshModuleProvider({
  controller,
  children,
}: {
  controller: SshController
  children?: ReactNode
}) {
  return (
    <SshControllerProvider controller={controller}>
      <SshBootstrap>{children}</SshBootstrap>
    </SshControllerProvider>
  )
}

function SshBootstrap({ children }: { children?: ReactNode }) {
  const { store } = useSshController()
  const loadConnections = store((state) => state.loadConnections)
  useEffect(() => {
    void loadConnections().catch((error: unknown) =>
      store.getState().setNotice(error instanceof Error ? error.message : String(error)),
    )
  }, [loadConnections, store])
  return (
    <>
      <SshMetricsPolling />
      {children}
    </>
  )
}

/** 指标轮询间隔：兼顾状态栏新鲜度与每次采样一条 ssh 的成本。 */
const METRICS_POLL_MS = 15_000

/**
 * 只给「有 live 终端」的连接采样。live 集合变化才重建定时器，
 * 没有连接中设备时一次请求都不发（折叠模块后终端卸载，集合自然清空）。
 */
function SshMetricsPolling() {
  const { store } = useSshController()
  const liveKey = useSshStore((state) =>
    Array.from(
      new Set(state.terminals.filter((tab) => tab.state === 'live').map((tab) => tab.connectionId)),
    )
      .sort((left, right) => left - right)
      .join(','),
  )
  // 打开面板时立即补一轮，不用等下一个周期。
  const resourcesOpen = useSshStore((state) => state.resourcesOpen)

  useEffect(() => {
    const ids = liveKey ? liveKey.split(',').map(Number) : []
    store.getState().retainMetrics(ids)
    if (ids.length === 0) return
    let cancelled = false
    const tick = (): void => {
      if (cancelled) return
      for (const id of ids) void store.getState().refreshMetrics(id)
    }
    tick()
    const timer = setInterval(tick, METRICS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [liveKey, resourcesOpen, store])

  return null
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
