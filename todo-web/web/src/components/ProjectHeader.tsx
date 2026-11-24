import { useState } from 'react'
import { formatTime } from '@/lib/format'
import { errorMessage } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'

function ProjectForm({ id }: { id: string | null }) {
  const project = useTodoStore((state) =>
    id ? state.projects.find((candidate) => candidate.id === id) : undefined,
  )
  const saveProject = useTodoStore((state) => state.saveProject)
  const cancelProjectForm = useTodoStore((state) => state.cancelProjectForm)

  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [path, setPath] = useState(project?.path ?? '')

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      alert('Project name is required')
      return
    }
    void saveProject(id, {
      name: trimmed,
      description: description.trim() || null,
      path: path.trim() || null,
    }).catch((error) => alert(`Failed to save project: ${errorMessage(error)}`))
  }

  return (
    <div className="project-edit">
      <div className="project-edit-row">
        <input
          type="text"
          className="form-input project-name-input"
          placeholder="Project name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </div>
      <div className="project-edit-row">
        <textarea
          className="form-textarea project-desc-input"
          placeholder="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="project-edit-row">
        <input
          type="text"
          className="form-input project-path-input"
          placeholder="Path (e.g., /path/to/project)"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
      </div>
      <div className="project-edit-actions">
        <button type="button" className="btn btn-sm" onClick={cancelProjectForm}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}

export function ProjectHeader() {
  const selectedProjectId = useTodoStore((state) => state.selectedProjectId)
  const project = useTodoStore((state) =>
    state.selectedProjectId
      ? state.projects.find((candidate) => candidate.id === state.selectedProjectId)
      : undefined,
  )
  const projectEditing = useTodoStore((state) => state.projectEditing)
  const projectDeleteConfirm = useTodoStore((state) => state.projectDeleteConfirm)
  const startEditProject = useTodoStore((state) => state.startEditProject)
  const requestDeleteProject = useTodoStore((state) => state.requestDeleteProject)
  const cancelDeleteProject = useTodoStore((state) => state.cancelDeleteProject)
  const removeProject = useTodoStore((state) => state.removeProject)
  const openNewTask = useTodoStore((state) => state.openNewTask)

  if (projectEditing) {
    return (
      <div className="project-header">
        <ProjectForm key={projectEditing.id ?? 'new'} id={projectEditing.id} />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="project-header">
        <div className="project-view">
          <div className="project-header-row">
            <h1 className="project-title">Select a project</h1>
          </div>
        </div>
      </div>
    )
  }

  const total =
    project.task_count.pending +
    project.task_count.in_progress +
    project.task_count.blocked +
    project.task_count.done

  if (projectDeleteConfirm) {
    return (
      <div className="project-header">
        <div className="project-delete-confirm">
          <span className="confirm-text">Delete this project?</span>
          <button type="button" className="btn btn-sm" onClick={cancelDeleteProject}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => {
              void removeProject().catch((error) =>
                alert(`Failed to delete project: ${errorMessage(error)}`),
              )
            }}
          >
            Delete
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="project-header">
      <div className="project-view">
        <div className="project-header-row">
          <h1 className="project-title">{project.name}</h1>
          <div className="project-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => startEditProject(project.id)}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={requestDeleteProject}
            >
              Delete
            </button>
          </div>
        </div>
        <div className="project-description">{project.description}</div>
        <div className="project-meta">
          {project.path ? <code className="project-path">{project.path}</code> : null}
          <span>Time: {formatTime(project.total_time_minutes)}</span>
          <span>Tasks: {total}</span>
          <button
            type="button"
            className="btn btn-sm project-new-task"
            disabled={!selectedProjectId}
            onClick={openNewTask}
          >
            + Task
          </button>
        </div>
      </div>
    </div>
  )
}
