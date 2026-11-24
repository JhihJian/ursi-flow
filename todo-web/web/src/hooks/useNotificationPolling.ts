import { useEffect, useRef } from 'react'
import { getStats } from '@/api/client'
import {
  playNotificationSound,
  requestNotificationPermission,
  showDesktopNotification,
} from '@/lib/notifications'
import { useTodoStore } from '@/store/todo-store'

export function useNotificationPolling() {
  const lastDone = useRef<number | null>(null)
  const refreshTasks = useTodoStore((state) => state.refreshTasks)

  useEffect(() => {
    void requestNotificationPermission()
  }, [])

  useEffect(() => {
    let disposed = false

    const check = async () => {
      try {
        const { stats } = await getStats('daily')
        if (disposed) return
        const done = stats.by_status.done
        const previous = lastDone.current
        lastDone.current = done
        if (previous === null || done <= previous) return

        void playNotificationSound()
        showDesktopNotification(done - previous)
        await refreshTasks()
      } catch (error) {
        console.info('Error checking for completed tasks:', error)
      }
    }

    const initial = window.setTimeout(() => void check(), 2000)
    const timer = window.setInterval(() => void check(), 30_000)
    return () => {
      disposed = true
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refreshTasks])
}
