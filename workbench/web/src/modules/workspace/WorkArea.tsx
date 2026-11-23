import { NavLink, Outlet } from 'react-router'
import { projectsPath } from '@/shared/api/work-projects'

export function WorkArea() {
  return <div className="min-w-0 space-y-4">
    <nav aria-label="工作视图" className="flex gap-4 border-b border-line text-sm">
      <NavLink to="/work-items" className="border-b-2 border-transparent px-1 py-2 text-txt2 hover:text-txt aria-[current=page]:border-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-2">全部事项</NavLink>
      <NavLink to={projectsPath} className="border-b-2 border-transparent px-1 py-2 text-txt2 hover:text-txt aria-[current=page]:border-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-2">项目</NavLink>
    </nav>
    <Outlet />
  </div>
}
