import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useEffect, useState } from 'react'
import type { Task } from '@/api/types'
import { MuteButton } from '@/components/MuteButton'
import { StatsHeader } from '@/components/StatsHeader'
import { TaskDragPreview } from '@/components/TaskSection'
import { Workspace } from '@/components/Workspace'
import { useNotificationPolling } from '@/hooks/useNotificationPolling'
import { errorMessage, readDropData, readTaskDrag } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'

export default function App() {
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

    const action =
      drop.type === 'status'
        ? moveTask(source.task, { status: drop.status })
        : moveTask(source.task, { projectId: drop.projectId })
    void action.catch((error) => alert(`Failed to update task: ${errorMessage(error)}`))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={() => setDraggingTask(null)}
      onDragEnd={handleDragEnd}
    >
      <StatsHeader />
      <Workspace />
      <DragOverlay dropAnimation={null}>
        {draggingTask ? <TaskDragPreview task={draggingTask} /> : null}
      </DragOverlay>
      <MuteButton />
    </DndContext>
  )
}
