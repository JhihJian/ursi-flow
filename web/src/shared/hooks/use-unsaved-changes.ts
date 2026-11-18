import { useCallback, useEffect, useRef } from 'react'
import { useBlocker } from 'react-router'
import { confirmAction } from '@/shared/stores/feedback'

/**
 * 编辑保护：路由内导航被阻塞时询问，刷新或关闭页面时交给浏览器确认。
 * 返回的 canLeave 供按钮等主动关闭路径先询问，未修改时立即返回 true。
 */
export function useUnsavedChanges(isDirty: () => boolean) {
  const dirtyRef = useRef(isDirty)
  useEffect(() => { dirtyRef.current = isDirty })

  const canLeave = useCallback(async () => {
    if (!dirtyRef.current()) return true
    return confirmAction({ title: '放弃未保存的更改？', description: '离开后，本次编辑的内容将不会保存。', confirmLabel: '放弃更改', danger: true })
  }, [])

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirtyRef.current() && currentLocation.pathname !== nextLocation.pathname)

  // 依赖对象只在状态切换时变化，避免同一次阻塞重复弹确认。
  const prompted = useRef<unknown>(null)
  useEffect(() => {
    if (blocker.state !== 'blocked') { prompted.current = null; return }
    if (prompted.current === blocker) return
    prompted.current = blocker
    void canLeave().then(allowed => {
      if (allowed) blocker.proceed()
      else blocker.reset()
    })
  }, [blocker, canLeave])

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])

  return { canLeave, blocker }
}
