import { useEffect } from 'react'
import { Workspace } from '@/components/Workspace'
import { useDaeStore } from '@/store/dae-store'

export default function App() {
  const bootstrap = useDaeStore((state) => state.bootstrap)
  const paused = useDaeStore((state) => state.paused)
  const tickSeconds = useDaeStore((state) => state.tickSeconds)
  const section = useDaeStore((state) => state.section)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // 单一定时器：切换分区或调整节奏时按当前分区重取数据，SSE 分区不受影响。
  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => {
      void useDaeStore.getState().refresh()
    }, tickSeconds * 1000)
    return () => clearInterval(timer)
  }, [paused, tickSeconds, section])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const state = useDaeStore.getState()
      if (state.selected) state.select(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return <Workspace />
}
