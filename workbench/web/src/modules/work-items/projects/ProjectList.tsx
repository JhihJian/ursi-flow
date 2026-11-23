import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { createProject, listProjects, projectPath } from '@/shared/api/work-projects'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { readPreferences, writePreferences } from './preferences'

export function ProjectList() {
  const projects = useResource(listProjects, [])
  const mutation = useMutation()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [preferences, setPreferences] = useState(readPreferences)
  const rows = [...projects.data].sort((a, b) => Number(preferences.pinned.includes(b.id)) - Number(preferences.pinned.includes(a.id)))
  const recent = preferences.recent
  function submit(event: FormEvent) {
    event.preventDefault()
    if (name.trim()) void mutation.run(signal => createProject(name.trim(), signal), project => navigate(`${projectPath(project.id)}/map`))
  }
  return <div className="page-stack">
    <PageHeader title="工作项目" />
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-sm sm:max-w-xs">项目名称<Input required value={name} onChange={event => setName(event.target.value)} /></label>
      <Button variant="primary" type="submit" loading={mutation.busy}>新建项目</Button>
      {recent && rows.some(project => project.id === recent.projectId) && <Button asChild><Link to={recent.path}>继续上次</Link></Button>}
    </form>
    {mutation.error && <p role="alert" className="text-err">{mutation.error}</p>}
    <ResourceState loading={projects.loading} error={projects.error} onRetry={projects.reload} empty={!rows.length} title="暂无项目" />
    <ul className="divide-y divide-line border-y border-line">{rows.map(project => {
      const pinned = preferences.pinned.includes(project.id)
      return <li key={project.id} className="flex items-center gap-3 py-2">
        <Link className="min-w-0 flex-1 break-all text-accent-2 hover:underline" to={`${projectPath(project.id)}/map`}>{project.name}</Link>
        <Button size="sm" variant="ghost" aria-pressed={pinned} onClick={() => {
          const next = { ...preferences, pinned: pinned ? preferences.pinned.filter(id => id !== project.id) : [...preferences.pinned, project.id] }
          writePreferences(next)
          setPreferences(next)
        }}>{pinned ? '取消置顶' : '置顶'}</Button>
      </li>
    })}</ul>
  </div>
}
