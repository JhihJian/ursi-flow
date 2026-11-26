import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useEffect, useState, type ReactNode } from 'react'
import type { Task } from './api/types'
import { TaskDragPreview } from './components/TaskSection'
import { useNotificationPolling } from './hooks/useNotificationPolling'
import { errorMessage, readDropData, readTaskDrag } from './lib/ui'
import { useTodoStore } from './store/todo-store'

/** 指针拖拽按光标位置判定落点；键盘拖拽没有指针坐标，退回元素中心距离。 */
const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args)
}

/**
 * todo 的模块级上下文：拖拽、数据加载、轮询与快捷键。
 * 侧边栏（项目列表）和工作区（任务列表）必须共享同一个 DndContext，
 * 所以它挂在 Provider 而不是任一栏里。
 */
export function TodoProvider({ children }: { children: ReactNode }) {
  const bootstrap = useTodoStore((state) => state.bootstrap)
  const moveTask = useTodoStore((state) => state.moveTask)
  const [draggingTask, setDraggingTask] = useState<Task | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )

  useEffect(() => {
    void bootstrap().catch((error) =>
      alert(`Failed to load dashboard: ${errorMessage(error)}`),
    )
  }, [bootstrap])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const state = useTodoStore.getState()
      if (state.projectEditing) {
        state.cancelProjectForm()
      } else if (state.detail) {
        state.closeDetail()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useNotificationPolling()

  const handleDragStart = (event: DragStartEvent) => {
    const source = readTaskDrag(event.active.data.current)
    setDraggingTask(source?.task ?? null)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingTask(null)
    const source = readTaskDrag(event.active.data.current)
    const drop = readDropData(event.over?.data.current)
    if (!source || !drop) return

    let blockedReason: string | undefined
    if (drop.type === 'status' && drop.status === 'blocked') {
      const reason = window.prompt(`Why is "${source.task.title}" blocked?`)
      if (reason === null) return
      if (!reason.trim()) {
        alert('A blocked task needs a reason')
        return
      }
      blockedReason = reason.trim()
    }

    const action =
      drop.type === 'status'
        ? moveTask(source.task, { status: drop.status }, blockedReason)
        : moveTask(source.task, { projectId: drop.projectId })
    void action.catch((error) => alert(`Failed to update task: ${errorMessage(error)}`))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragCancel={() => setDraggingTask(null)}
      onDragEnd={handleDragEnd}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {draggingTask ? <TaskDragPreview task={draggingTask} /> : null}
      </DragOverlay>
    </DndContext>
  )
}
