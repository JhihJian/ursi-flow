import type { TerminalState } from './store/ssh-store'

/** 终端生命周期文案：折叠条与状态栏共用。 */
export const STATE_LABEL: Record<TerminalState, string> = {
  connecting: '连接中',
  live: '已连接',
  ended: '已退出',
  error: '出错',
  closed: '未连接',
}
