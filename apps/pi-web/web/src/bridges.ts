import type { PiView } from './pi-context'

/**
 * 模块内的一次性接线位。
 *
 * 三个视图工厂在模块创建时就固定了回调，而控制器要等渲染后才有；用一个可替换的
 * 引用把「切换视图」「打开会话」「续聊」三件事接起来，避免把控制器塞进工厂参数。
 */
export interface PiBridges {
  setView: (view: PiView) => void
  /** 在会话视图打开某条会话（对话视图的「看完整轨迹」用它）。 */
  openSessionInSessions: (target: { root?: string; sessionFile?: string; id?: string }) => Promise<void>
  /** 在对话视图继续某条会话（会话视图的「在对话里继续」用它）。 */
  resumeInChat: (sessionFile: string) => Promise<void>
}

export const bridges: PiBridges = {
  setView: () => undefined,
  openSessionInSessions: async () => {
    throw new Error('会话视图未挂载')
  },
  resumeInChat: async () => {
    throw new Error('对话视图未挂载')
  },
}
