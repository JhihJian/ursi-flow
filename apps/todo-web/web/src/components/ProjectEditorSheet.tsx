import { useEffect, useState } from 'react'
import { DirBrowser } from '@ursi/directory-picker'
import type { DeviceOption } from '@ursi/directory-picker'
import { parse } from '@ursi/location'
import { region } from '@demand/react'
import type { ProjectStats } from '@/api/types'
import { errorMessage } from '@/lib/ui'
import { useTodoHost } from '@/module'
import { useTodoStore } from '@/store/todo-store'

interface ProjectFormProps {
  id: string | null
  project?: ProjectStats
}

function ProjectForm({ id, project }: ProjectFormProps) {
  const saveProject = useTodoStore((state) => state.saveProject)
  const cancelProjectForm = useTodoStore((state) => state.cancelProjectForm)
  const host = useTodoHost()

  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [path, setPath] = useState(project?.path ?? '')
  const [browsing, setBrowsing] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // 设备清单由组合根注入（ssh-web）；独立运行或宿主未接时为空，选目录器只有本机。
  const listDevices = host.devices
  const [devices, setDevices] = useState<DeviceOption[]>([])
  useEffect(() => {
    if (!listDevices) return
    let cancelled = false
    listDevices()
      .then((list) => {
        if (!cancelled) setDevices(list.map((item) => ({ device: item.device, label: item.label })))
      })
      .catch(() => {
        if (!cancelled) setDevices([])
      })
    return () => {
      cancelled = true
    }
  }, [listDevices])

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setFormError('Project name is required')
      return
    }
    // 目录是位置 URI：手输的裸路径按本机简写规范化成 file:///，ssh:// 原样保留。
    // 这里只做形态规范化，不展开 `~`、不探活，远程目录的处理交给接收方。
    const typedPath = path.trim()
    let normalizedPath: string | null = null
    if (typedPath) {
      try {
        normalizedPath = parse(typedPath).uri
      } catch (error) {
        setFormError(errorMessage(error))
        return
      }
    }
    setFormError(null)
    void saveProject(id, {
      name: trimmed,
      description: description.trim() || null,
      path: normalizedPath,
    }).catch((error) => setFormError(`Failed to save project: ${errorMessage(error)}`))
  }

  return (
    <section
      className="project-sheet"
      {...region('project-editor')}
      role="dialog"
      aria-modal="false"
      aria-label="Project form"
    >
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
          <div className="project-sheet-field">
            <label className="project-sheet-field">
              <span className="form-label">Path</span>
              <input
                className="form-input"
                type="text"
                placeholder="路径或 ssh://设备/路径，如 /data/dev/x"
                value={path}
                aria-label="Project path"
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            {host.listDir ? (
              browsing ? (
                <DirBrowser
                  listDir={host.listDir}
                  initialPath={path.trim() || '~'}
                  devices={devices}
                  onSelect={(uri) => {
                    setPath(uri)
                    setBrowsing(false)
                  }}
                  onCancel={() => setBrowsing(false)}
                  selectLabel="使用此目录"
                />
              ) : (
                <button
                  type="button"
                  className="project-sheet-browse"
                  onClick={() => setBrowsing(true)}
                >
                  浏览目录…
                </button>
              )
            ) : null}
          </div>
        </div>
        {formError ? (
          <p className="project-sheet-error" role="alert">
            {formError}
          </p>
        ) : null}
      </div>
      <footer className="detail-footer">
        <div className="detail-modes" />
        <div className="detail-actions">
          <button type="button" className="btn" onClick={cancelProjectForm}>
            cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            save
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
