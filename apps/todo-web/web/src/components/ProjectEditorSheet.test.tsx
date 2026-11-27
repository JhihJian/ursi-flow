import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ListDirFn } from '@ursi/directory-picker'
import type { ProjectInput } from '@/api/types'
import { TodoHostProvider } from '@/module'
import { useTodoStore } from '@/store/todo-store'
import { ProjectEditorSheet } from './ProjectEditorSheet'

vi.mock('@/api/client', () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  listDailyCounts: vi.fn(),
  getStats: vi.fn(),
}))

afterEach(() => {
  cleanup()
})

function openEditor(path: string | null) {
  useTodoStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'Alpha',
        created_at: '2026-03-01T09:00:00Z',
        description: null,
        path,
        task_count: { pending: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0 },
        total_time_minutes: 0,
      },
    ],
    selectedProjectId: 'p1',
    projectEditing: { id: 'p1' },
  })
}

function renderSheet(host: Parameters<typeof TodoHostProvider>[0]['host'] = {}) {
  const saveProject = vi.fn(async () => {})
  useTodoStore.setState({ saveProject })
  const view = render(
    <TodoHostProvider host={host}>
      <ProjectEditorSheet />
    </TodoHostProvider>,
  )
  const input = view.getByLabelText('Project path') as HTMLInputElement
  const save = () => fireEvent.click(view.getByText('save'))
  return { ...view, input, save, saveProject }
}

beforeEach(() => {
  useTodoStore.setState({ projectEditing: null })
})

describe('项目编辑面板', () => {
  it('host 未注入 listDir 时不显示「浏览目录…」', () => {
    openEditor('/data/dev/x')
    const view = renderSheet({})
    expect(view.queryByText('浏览目录…')).toBeNull()
  })

  it('注入 listDir 后显示「浏览目录…」，展开后选中目录写回 URI 并收起', async () => {
    openEditor('')
    const listDir = vi.fn<ListDirFn>(async () => ({
      location: { uri: 'ssh://nm105/srv', scheme: 'ssh', device: 'nm105', path: '/srv' },
      parent: null,
      entries: [],
    }))
    const view = renderSheet({ listDir })
    fireEvent.click(view.getByText('浏览目录…'))
    // 空路径从主目录起步浏览。
    expect(listDir).toHaveBeenCalledWith('~')
    fireEvent.click(await view.findByText('使用此目录'))
    expect(view.input.value).toBe('ssh://nm105/srv')
    // 收起后按钮回来，选目录器不再渲染。
    await waitFor(() => expect(view.getByText('浏览目录…')).toBeTruthy())
    expect(view.container.querySelector('.dp')).toBeNull()
  })

  it('保存时裸路径规范化为 file URI，ssh URI 原样', () => {
    openEditor('/data/x/')
    const view = renderSheet()
    view.save()
    expect(view.saveProject).toHaveBeenCalledWith('p1', {
      name: 'Alpha',
      description: null,
      path: 'file:///data/x',
    } satisfies ProjectInput)
    cleanup()

    openEditor('ssh://nm105/srv')
    const remote = renderSheet()
    remote.save()
    expect(remote.saveProject).toHaveBeenCalledWith('p1', {
      name: 'Alpha',
      description: null,
      path: 'ssh://nm105/srv',
    } satisfies ProjectInput)
  })

  it('路径非法时就地显示错误，不保存也不 alert', () => {
    openEditor('relative/path')
    const alert = vi.spyOn(window, 'alert')
    const view = renderSheet()
    view.save()
    expect(view.saveProject).not.toHaveBeenCalled()
    expect(view.getByRole('alert').textContent).toContain('位置必须是绝对路径或 URI')
    expect(alert).not.toHaveBeenCalled()
  })
})
