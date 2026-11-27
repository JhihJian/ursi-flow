import { createContext, useContext } from 'react'
import type { ListDirFn } from '@ursi/directory-picker'

/** flow 模块需要的宿主能力；由组合根经工厂选项注入，组件经 React context 读取，不进 store。 */
export interface FlowHost {
  /**
   * 浏览本机目录，给 flow home 的选目录器当数据源。
   * 不提供设备清单：flow home 必须在工作台所在机器上，选目录器只有本机一项。
   */
  listDir?: ListDirFn
}

export const FlowHostContext = createContext<FlowHost>({})

/** 组合根没接 `host` 时返回空对象，调用方按 `listDir` 是否存在决定要不要显示选目录器。 */
export function useFlowHost(): FlowHost {
  return useContext(FlowHostContext)
}
