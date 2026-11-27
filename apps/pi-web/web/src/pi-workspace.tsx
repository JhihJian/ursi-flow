import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { usePiNav } from './pi-nav'

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
 * 工作区：两种页面（会话、配置）按 PiNav 渲染。
 * 会话页只有一个：空会话页与某条会话是同一个组件、同一个实例，按 sessionId 区分；
 * 换会话时流式片段由 ChatProvider 清掉，不靠重挂。
 * 配置页首次进入才挂载，挂载后保留。
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
            {/* 不按会话建键：从空会话页到建完对话是同一个实例，输入框里正在打的字不丢。 */}
            <SessionThreadLazy sessionId={page.id} />
          </Suspense>
        ) : null}
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
