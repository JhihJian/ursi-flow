import { useState } from 'react'
import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import { sidebarItems } from '../lib/flow'
import { useFlowStore } from '../store'

/**
 * 外壳里的 Flow 侧边栏：外框用平台的 SidebarFrame，与文件、待办一致。
 * 上半是 flow home 配置，下半是 Flow 包清单；折叠条给出当前 Flow 与运行中数量。
 */
export function FlowSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  const {
    config,
    flows,
    flowId,
    runs,
    busy,
    selectFlow,
    refresh,
    saveHome,
  } = useFlowStore()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const selected = flows.find((flow) => flow.id === flowId)
  const running = runs.filter((run) => run.status === 'running').length

  return (
    <SidebarFrame
      title="Flow"
      collapsed={collapsed}
      collapse={collapse}
      expand={expand}
      items={sidebarItems({
        ...(selected === undefined ? {} : { selectedName: selected.name }),
        running,
        flowCount: flows.length,
      })}
    >
      <div className="flow-sidebar">
        <section className="flow-home">
          <div className="flow-section-head">
            <span>flow home</span>
            <button
              type="button"
              className="flow-link"
              onClick={() => {
                setDraft(config?.flowHome ?? '')
                setEditing((current) => !current)
              }}
            >
              {editing ? '取消' : '修改'}
            </button>
          </div>
          {editing ? (
            <form
              className="flow-home-form"
              onSubmit={(event) => {
                event.preventDefault()
                void saveHome(draft).then(() => setEditing(false))
              }}
            >
              <input
                className="flow-input"
                value={draft}
                aria-label="flow home 目录"
                placeholder="~/.ursi/flow 的绝对路径"
                onChange={(event) => setDraft(event.target.value)}
                autoFocus
              />
              <button type="submit" className="flow-button" disabled={busy === 'save-home'}>
                {busy === 'save-home' ? '保存中' : '保存'}
              </button>
            </form>
          ) : (
            <code className="flow-home-path" title={config?.flowHome ?? ''}>
              {config === undefined ? '读取中' : config.flowHome}
            </code>
          )}
        </section>

        <section className="flow-flows">
          <div className="flow-section-head">
            <span>Flow 包</span>
            <button
              type="button"
              className="flow-link"
              onClick={() => void refresh()}
              disabled={busy === 'refresh'}
            >
              {busy === 'refresh' ? '刷新中' : '刷新'}
            </button>
          </div>
          {flows.length === 0 ? (
            <p className="flow-empty">
              这个目录下还没有 Flow 包。把一个包含 FLOW.md 的目录放进来，再点刷新。
            </p>
          ) : (
            <ul className="flow-list">
              {flows.map((flow) => (
                <li key={flow.id}>
                  <button
                    type="button"
                    className={`flow-item${flow.id === flowId ? ' is-selected' : ''}${flow.valid ? '' : ' is-broken'}`}
                    aria-current={flow.id === flowId ? 'true' : undefined}
                    onClick={() => void selectFlow(flow.id)}
                  >
                    <span className="flow-item-name">{flow.name}</span>
                    <span className="flow-item-meta">
                      {flow.id} · {flow.nodeCount} 节点 · {flow.variableCount} 变量
                      {flow.valid ? '' : ' · 无法解析'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SidebarFrame>
  )
}
