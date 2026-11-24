import { useState } from 'react'
import type { ProjectStats } from '@/api/types'
import { errorMessage } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'

interface ProjectFormProps {
  id: string | null
  project?: ProjectStats
}

function ProjectForm({ id, project }: ProjectFormProps) {
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
    <section className="project-sheet" role="dialog" aria-modal="false" aria-label="Project form">
      <div className="project-sheet-body">
        <input
          className="detail-title-input"
          type="text"
          placeholder="Project name"
          value={name}
          aria-label="Project name"
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <div className="project-sheet-fields">
          <label className="project-sheet-field">
            <span className="form-label">Description</span>
            <textarea
              className="form-textarea project-sheet-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="project-sheet-field">
            <span className="form-label">Path</span>
            <input
              className="form-input"
              type="text"
              placeholder="/path/to/project"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
        </div>
      </div>
      <footer className="detail-footer">
        <div className="detail-modes" />
        <div className="detail-actions">
          <button type="button" className="btn" onClick={cancelProjectForm}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </footer>
    </section>
  )
}

/** 项目的新建与编辑都在这块底部面板里完成。 */
export function ProjectEditorSheet() {
  const editing = useTodoStore((state) => state.projectEditing)
  const project = useTodoStore((state) =>
    state.projectEditing?.id
      ? state.projects.find((candidate) => candidate.id === state.projectEditing?.id)
      : undefined,
  )

  if (!editing) return null
  return <ProjectForm key={editing.id ?? 'new'} id={editing.id} project={project} />
}
