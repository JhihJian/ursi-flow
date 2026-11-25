import { Fragment, createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ModuleSidebarProps, WorkspaceModule } from './contracts'

/**
 * 槽位注册表：外壳在侧边栏 / 工作区 / 状态栏里各放一个占位 div，
 * 模块的侧边栏、工作区、状态栏组件由 ModuleHost 通过 portal 投递进去。
 * portal 保留 React 上下文，模块声明的 Provider 因此能同时包住三块内容。
 */
type SlotMap = Record<string, HTMLElement | null>

interface SlotApi {
  slots: SlotMap
  setSlot: (name: string, element: HTMLElement | null) => void
}

const SlotContext = createContext<SlotApi | null>(null)

export function SlotProvider({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<SlotMap>({})
  const setSlot = useCallback((name: string, element: HTMLElement | null) => {
    setSlots((previous) => (previous[name] === element ? previous : { ...previous, [name]: element }))
  }, [])
  const value = useMemo(() => ({ slots, setSlot }), [slots, setSlot])
  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>
}

function useSlotApi(): SlotApi {
  const value = useContext(SlotContext)
  if (!value) throw new Error('槽位必须在 WorkspaceShell 内使用')
  return value
}

export function useSlots(): SlotMap {
  return useSlotApi().slots
}

/** 槽位占位元素：挂载时登记，卸载时注销。ref 回调必须稳定，否则每次渲染都会重登记并触发循环。 */
export function Slot({ name, className }: { name: string; className?: string }) {
  const { setSlot } = useSlotApi()
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      setSlot(name, element)
      return () => setSlot(name, null)
    },
    [name, setSlot],
  )
  return <div className={className} ref={ref} />
}

export const sidebarSlotName = (moduleId: string) => `${moduleId}:sidebar`
export const workspaceSlotName = (moduleId: string) => `${moduleId}:workspace`
export const hiddenSlotName = (moduleId: string) => `${moduleId}:hidden`
export const statusSlotName = (moduleId: string) => `${moduleId}:status`

/**
 * 一个模块的唯一挂载点：声明一次 Provider，侧边栏 / 工作区 / 状态栏三块内容
 * 通过 portal 落到外壳的三个区域，共享同一份 React 上下文。
 * 折叠时工作区默认卸载；声明 keepMounted 的模块改投隐藏槽，保持运行状态。
 */
export function ModuleHost({
  module,
  sidebarProps,
  workspaceVisible,
  statusVisible,
}: {
  module: WorkspaceModule
  sidebarProps: ModuleSidebarProps
  workspaceVisible: boolean
  statusVisible: boolean
}) {
  const slots = useSlots()
  const Sidebar = module.Sidebar
  const Workspace = module.Workspace
  const Status = module.context.Status
  const Provider = module.Provider

  const sidebarSlot = slots[sidebarSlotName(module.id)]
  const workspaceSlot = workspaceVisible
    ? slots[workspaceSlotName(module.id)]
    : module.keepMounted
      ? slots[hiddenSlotName(module.id)]
      : null
  const statusSlot = statusVisible ? slots[statusSlotName(module.id)] : null

  const content = (
    <>
      {sidebarSlot ? createPortal(<Sidebar {...sidebarProps} />, sidebarSlot) : null}
      {workspaceSlot ? createPortal(<Workspace />, workspaceSlot) : null}
      {Status && statusSlot ? createPortal(<Status />, statusSlot) : null}
    </>
  )

  return Provider ? <Provider>{content}</Provider> : <Fragment>{content}</Fragment>
}
