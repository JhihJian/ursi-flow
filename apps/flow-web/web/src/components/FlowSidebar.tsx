import { useState } from 'react'
import { DirBrowser } from '@ursi/directory-picker'
import { SidebarRow } from '@ursi/sidebar'
import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import { useFlowHost } from '../host'
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
  const { listDir } = useFlowHost()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [browsing, setBrowsing] = useState(false)

  const selected = flows.find((flow) => flow.id === flowId)
  const running = runs.filter((run) => run.status === 'running').length

  const stopEditing = () => {
    setEditing(false)
    setBrowsing(false)
  }

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
                if (editing) stopEditing()
                else {
                  setDraft(config?.flowHome ?? '')
                  setEditing(true)
                }
              }}
            >
              {editing ? '取消' : '修改'}
            </button>
          </div>
          {editing ? (
            <>
              <form
                className="flow-home-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void saveHome(draft).then(stopEditing)
                }}
              >
                <input
                  className="flow-input"
                  value={draft}
                  aria-label="flow home 目录"
                  placeholder="路径，如 /data/flows"
                  onChange={(event) => setDraft(event.target.value)}
                  autoFocus
                />
                <button
                  type="submit"
                  className="flow-button"
                  disabled={busy === 'save-home'}
                >
                  {busy === 'save-home' ? '保存中' : '保存'}
                </button>
              </form>
              {/* 选目录器只有本机：flow home 必须在工作台所在机器上，不注入设备清单。 */}
              {listDir === undefined ? null : browsing ? (
                <div className="flow-home-browse">
                  <DirBrowser
                    listDir={listDir}
                    initialPath={config?.flowHome ?? '~'}
                    onSelect={(uri) => void saveHome(uri).then(stopEditing)}
                    onCancel={stopEditing}
                    selectLabel="使用此目录"
                    placeholder="路径回车跳转，如 /data/flows"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="flow-browse-toggle"
                  onClick={() => setBrowsing(true)}
                >
                  浏览目录…
                </button>
              )}
            </>
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
                  <SidebarRow
                    className={flow.valid ? 'flow-item' : 'flow-item is-broken'}
                    active={flow.id === flowId}
                    ariaCurrent={flow.id === flowId ? 'true' : undefined}
                    onClick={() => void selectFlow(flow.id)}
                    label={flow.name}
                    meta={
                      <>
                        {flow.id} · {flow.nodeCount} 节点 · {flow.variableCount} 变量
                        {flow.valid ? '' : ' · 无法解析'}
                      </>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SidebarFrame>
  )
}
