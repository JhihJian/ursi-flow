import { useSshStore } from '../ssh-context'
import { latencyText, memoryPercent, percentText } from '../resource-metrics'
import { STATE_LABEL } from '../terminal-state'

/**
 * 状态栏：激活终端的连接、会话、生命周期，以及该设备的缩略指标（负载 / 内存 / 延迟）。
 * 模块嵌入时由工作区外壳的状态栏槽位渲染，独立入口在底部自绘一条同样高度的栏；
 * 「资源」按钮开合工作区右侧的设备资源面板。
 */
export function SshStatus() {
  const connections = useSshStore((state) => state.connections)
  const terminals = useSshStore((state) => state.terminals)
  const activeTerminalKey = useSshStore((state) => state.activeTerminalKey)
  const resourcesOpen = useSshStore((state) => state.resourcesOpen)
  const toggleResources = useSshStore((state) => state.toggleResources)
  // 只订阅激活连接的那份采样：其他设备的采样更新不重渲染状态栏。
  const sample = useSshStore((state) => {
    const tab = state.terminals.find((item) => item.key === state.activeTerminalKey)
    return tab ? (state.metricsByConnection[tab.connectionId]?.sample ?? null) : null
  })

  const activeTab = terminals.find((tab) => tab.key === activeTerminalKey)
  const connection = activeTab
    ? connections.find((item) => item.id === activeTab.connectionId)
    : undefined
  const live = activeTab?.state === 'live'

  return (
    <span className="ssh-status">
      <span className="ssh-status-text">
        SSH{' '}
        {activeTab
          ? `${connection?.name ?? '…'}/${activeTab.tmuxSession ?? 'ssh-main'} · `
          : ''}
        {STATE_LABEL[activeTab?.state ?? 'closed'] ?? '未连接'}
        {live ? (
          <>
            <span className="ssh-status-metric">
              CPU {percentText(sample?.cpu_percent ?? null)}
            </span>
            <span className="ssh-status-metric">
              内存 {percentText(sample ? memoryPercent(sample) : null)}
            </span>
            <span className="ssh-status-metric">延迟 {latencyText(sample?.latency_ms ?? null)}</span>
          </>
        ) : null}
        {terminals.length > 1 ? <span className="ssh-status-metric">标签 {terminals.length}</span> : null}
      </span>
      <button
        type="button"
        className="ssh-status-toggle"
        aria-expanded={resourcesOpen}
        title={resourcesOpen ? '收起资源面板' : '展开资源面板'}
        onClick={toggleResources}
      >
        资源
      </button>
    </span>
  )
}
