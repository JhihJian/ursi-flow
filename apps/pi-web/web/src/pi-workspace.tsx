import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { usePiNav } from './pi-nav'
import { DraftPage } from './draft-page'

/**
 * 轨迹组件库单文件约 1MB，只在工作区需要时加载。
 */
const SessionThreadLazy = lazy(() =>
  import('./session-thread').then((module) => ({ default: module.SessionThread })),
)
const ConfigPageLazy = lazy(() =>
  import('./config-page').then((module) => ({ default: module.ConfigPage })),
)

function WorkspaceFallback({ text }: { text: string }) {
  return (
    <div className="pichat pichat-workspace">
      <div className="pichat-center">
        <p className="pichat-hint">{text}</p>
      </div>
    </div>
  )
}

/**
 * 工作区：三种页面（新对话、会话、配置）按 PiNav 渲染。
 * 配置页首次进入才挂载，挂载后保留；会话页按 sessionFile 建键，换会话就是换页面。
 */
export function PiWorkspace(): ReactNode {
  const { page } = usePiNav()
  const [configSeen, setConfigSeen] = useState(false)
  useEffect(() => {
    if (page.kind === 'config') setConfigSeen(true)
  }, [page])

  return (
    <div className="pi-workspace">
      <div className="pi-workspace-page" hidden={page.kind === 'config'}>
        {page.kind === 'session' ? (
          <Suspense fallback={<WorkspaceFallback text="加载会话…" />}>
            <SessionThreadLazy key={page.sessionFile} sessionFile={page.sessionFile} />
          </Suspense>
        ) : (
          <DraftPage />
        )}
      </div>
      {configSeen ? (
        <div className="pi-workspace-page" hidden={page.kind !== 'config'}>
          <Suspense fallback={<WorkspaceFallback text="加载配置…" />}>
            <ConfigPageLazy />
          </Suspense>
        </div>
      ) : null}
    </div>
  )
}
