import { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceProfile, WorkspaceView } from '@ursi/workspace-shell'
import { WorkspaceShell, useWorkspace } from '@ursi/workspace-shell'
import { SKELETON_MODULES } from './modules'
import './skeleton.css'

/** 骨架预览入口：不依赖后端与真实模块，只展示五个区域的结构与交互。 */

const HOST_KIND = 'skeleton.host'

function HostView() {
  return (
    <div className="sk-host-page">
      <h2 className="sk-host-title">宿主页面</h2>
      <p>设置、注册表这类页面通过 views 注册，选中后占用整个工作区，侧边栏堆叠不受影响。</p>
      <ul className="sk-host-list">
        <li>侧边栏：每节可折叠、可拖动调高，折叠后只留一条窄条。</li>
        <li>工作区：只显示侧边栏处于展开态的模块，多模块并排各占一列。</li>
        <li>控制面板：按选中列出模块声明的操作。</li>
        <li>状态栏：展开模块各自贡献一段上下文。</li>
      </ul>
    </div>
  )
}

const VIEWS: WorkspaceView[] = [
  { kind: HOST_KIND, summary: () => '宿主页面', Component: HostView },
]

const PROFILES: WorkspaceProfile[] = [
  { id: 'all', title: '全部', modules: ['tasks', 'files', 'terminal', 'sandboxes'] },
  { id: 'work', title: '工作', modules: ['tasks', 'files'] },
  { id: 'ops', title: '运维', modules: ['terminal', 'sandboxes'] },
]

const SELECTED = { kind: HOST_KIND, id: 'host' }

function HostButton() {
  const { selection, select } = useWorkspace()
  const active = selection?.kind === HOST_KIND
  return (
    <button
      type="button"
      className="ws-settings"
      onClick={() => select(active ? null : SELECTED)}
    >
      {active ? '返回模块' : '宿主页面'}
    </button>
  )
}

export default function SkeletonApp() {
  const views = useMemo(() => VIEWS, [])
  return (
    <WorkspaceShell
      modules={SKELETON_MODULES}
      views={views}
      profiles={PROFILES}
      title="骨架预览"
      settings={<HostButton />}
      status="示例模块 · 无后端"
      storageKey="ursi.skeleton"
    />
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')
createRoot(container).render(<SkeletonApp />)
