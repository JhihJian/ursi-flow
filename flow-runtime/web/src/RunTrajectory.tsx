// 节点会话轨迹：把 daemon 保存的 Pi JSONL 切片交给 pi-agent-trajectory-viewer 渲染。
// 查看器源码在 src/trajectory（由 scripts/sync-trajectory-viewer.mjs 同步），这里只做数据与主题桥接。
import React, { useEffect, useMemo, useState } from 'react'
import { Alert, AlertDescription } from './components/ui/alert'
import { parsePiJsonl } from './trajectory/lib/parser.js'
import { TrajectoryViewer } from './trajectory/components/TrajectoryViewer.jsx'

// 上游是无类型的 JSX 组件；这里只声明控制台实际使用的两个受控属性。
const Viewer = TrajectoryViewer as unknown as (props: {
  turns: unknown[]
  sessionRevision?: number
}) => React.ReactNode

/** 进程被终止时最后一行可能没写完，丢掉它比整份轨迹解析失败更有用。 */
function complete(text: string): string {
  if (text.endsWith('\n')) return text
  const cut = text.lastIndexOf('\n')
  return cut < 0 ? '' : text.slice(0, cut + 1)
}

/** 查看器的深色样式绑定在容器属性上，跟随控制台的 data-theme 变化。 */
function useDarkTheme() {
  const read = () => {
    const root = document.documentElement
    return root.dataset.theme === 'dark' || root.classList.contains('dark')
  }
  const [dark, setDark] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  return dark
}

export default function RunTrajectory({ jsonl }: { jsonl: string }) {
  const dark = useDarkTheme()
  const parsed = useMemo(() => {
    const text = complete(jsonl)
    if (!text.trim()) return { error: '这次节点执行还没有写入会话轨迹。' }
    try {
      return { turns: parsePiJsonl(text).turns }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [jsonl])
  if ('error' in parsed)
    return (
      <Alert variant="error">
        <AlertDescription>轨迹无法解析：{parsed.error}</AlertDescription>
      </Alert>
    )
  return (
    <div className="trajectory-host" data-ds-dark-theme={dark ? 'true' : undefined}>
      <Viewer turns={parsed.turns} sessionRevision={jsonl.length} />
    </div>
  )
}
