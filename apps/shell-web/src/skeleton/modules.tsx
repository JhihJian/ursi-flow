import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { ModuleSidebarProps, WorkspaceModule } from '@ursi/workspace-shell'
import { SidebarFrame, useWorkspace } from '@ursi/workspace-shell'

/**
 * 骨架预览用的示例模块。它们不连任何后端，只把外壳的五个区域填满：
 * 侧边栏堆叠、工作区多列、状态栏上下文、右侧控制面板动作。
 * 真实模块的接入方式见 packages/workspace-shell/MODULE-CONTRACT.md。
 */

/** 元素尺寸：预览里在每个区域角上标注实际拿到的大小，便于核对布局。 */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) {
        setSize({ width: Math.round(box.width), height: Math.round(box.height) })
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, size] as const
}

interface DemoSpec {
  id: string
  title: string
  /** 侧边栏里的占位行，点击即发布选中。 */
  rows: string[]
  /** 工作区占位块数量。 */
  panes: number
  /** 该模块发布的选中类型。 */
  kind: string
  sidebarDefaultSize: number
  sidebarMinSize: number
}

/** 工作区占位块：不画模块标题，只标出自己所在的位置与尺寸。 */
function Placeholder({ label }: { label: string }) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  return (
    <div className="sk-block" ref={ref}>
      <span className="sk-block-label">{label}</span>
      <span className="sk-block-size">
        {size.width} × {size.height}
      </span>
    </div>
  )
}

function DemoWorkspace({ spec }: { spec: DemoSpec }) {
  const { selection } = useWorkspace()
  const active = selection?.kind === spec.kind ? selection.label ?? selection.id : null
  return (
    <div className="sk-workspace">
      <div className="sk-workspace-grid" data-panes={spec.panes}>
        {Array.from({ length: spec.panes }, (_, index) => (
          <Placeholder
            key={index}
            label={active ? `${spec.title} · ${active}` : `${spec.title} · 工作区 ${index + 1}`}
          />
        ))}
      </div>
    </div>
  )
}

function DemoStatus({ spec }: { spec: DemoSpec }) {
  const { selection } = useWorkspace()
  const active = selection?.kind === spec.kind ? selection.label ?? selection.id : null
  return (
    <span>
      {spec.title} {spec.rows.length}
      {active ? ` · ${active}` : ''}
    </span>
  )
}

function createDemoModule(spec: DemoSpec): WorkspaceModule {
  const Sidebar = ({ collapsed, collapse, expand }: ModuleSidebarProps) => {
    const { selection, select } = useWorkspace()
    return (
      <SidebarFrame
        title={spec.title}
        collapsed={collapsed}
        collapse={collapse}
        expand={expand}
        items={[
          { label: '条目', value: String(spec.rows.length) },
          { label: '选中', value: selection?.kind === spec.kind ? (selection.label ?? selection.id) : '无' },
        ]}
      >
        <ul className="sk-list">
          {spec.rows.map((row) => {
            const active = selection?.kind === spec.kind && selection.id === row
            return (
              <li key={row}>
                <button
                  type="button"
                  className={active ? 'sk-row sk-row-active' : 'sk-row'}
                  onClick={() => select({ kind: spec.kind, id: row, label: row })}
                >
                  {row}
                </button>
              </li>
            )
          })}
        </ul>
      </SidebarFrame>
    )
  }

  return {
    id: spec.id,
    title: spec.title,
    Sidebar,
    Workspace: () => <DemoWorkspace spec={spec} />,
    context: {
      kind: spec.kind,
      summary: (selection) => selection.label ?? selection.id,
      Status: () => <DemoStatus spec={spec} />,
    },
    sidebarDefaultSize: spec.sidebarDefaultSize,
    sidebarMinSize: spec.sidebarMinSize,
    actions: [
      {
        id: `${spec.id}.open`,
        label: '打开选中项',
        appliesTo: (selection) => selection?.kind === spec.kind,
        run: async (selection) => {
          // 预览里用 alert 之外的轻提示不合适，这里直接写入状态栏可读的选中标题。
          console.info(`[skeleton] 打开 ${spec.title} · ${selection.label ?? selection.id}`)
        },
      },
      {
        id: `${spec.id}.remove`,
        label: '移除选中项',
        appliesTo: (selection) => selection?.kind === spec.kind,
        confirm: `确定移除「${spec.title}」里的这一项？`,
        run: async (selection) => {
          console.info(`[skeleton] 移除 ${spec.id} · ${selection.id}`)
        },
      },
    ],
  }
}

/**
 * 共享上下文的示例：侧边栏里的 + 按钮与工作区里的计数读的是同一份状态，
 * 证明 Provider 把两块内容包在同一个 React 上下文里（portal 保留上下文）。
 */
const TabsContext = createContext<{ count: number; add: () => void } | null>(null)

function TabsProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(2)
  return (
    <TabsContext.Provider value={{ count, add: () => setCount((value) => value + 1) }}>
      {children}
    </TabsContext.Provider>
  )
}

function useTabs() {
  const value = useContext(TabsContext)
  if (!value) throw new Error('示例模块缺少 TabsProvider')
  return value
}

function SharedSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  const { count, add } = useTabs()
  return (
    <SidebarFrame
      title="终端"
      collapsed={collapsed}
      collapse={collapse}
      expand={expand}
      items={[{ label: '会话', value: String(count) }]}
    >
      <div className="sk-shared">
        <p className="sk-hint">侧边栏与工作区共享同一份计数：</p>
        <div className="sk-shared-row">
          <span className="sk-shared-count">会话 {count}</span>
          <button type="button" className="sk-button" onClick={add}>
            新建会话
          </button>
        </div>
        <p className="sk-hint">点新建后右侧工作区里的数字同步变化。</p>
      </div>
    </SidebarFrame>
  )
}

function SharedWorkspace() {
  const { count } = useTabs()
  return (
    <div className="sk-workspace">
      <div className="sk-workspace-grid" data-panes={1}>
        <div className="sk-block">
          <span className="sk-block-label">终端 · 工作区</span>
          <span className="sk-shared-count">会话 {count}</span>
          <span className="sk-block-size">与侧边栏同一份 Provider 状态</span>
        </div>
      </div>
    </div>
  )
}

function SharedStatus() {
  const { count } = useTabs()
  return <span>终端 {count}</span>
}

function createSharedContextModule(): WorkspaceModule {
  return {
    id: 'terminal',
    title: '终端',
    Provider: TabsProvider,
    Sidebar: SharedSidebar,
    Workspace: SharedWorkspace,
    context: { Status: SharedStatus },
    sidebarDefaultSize: 260,
    sidebarMinSize: 160,
    actions: [],
  }
}

const TASKS: DemoSpec = {
  id: 'tasks',
  title: '任务',
  rows: ['整理需求', '拆分模块', '补测试', '更新文档'],
  panes: 1,
  kind: 'demo.task',
  sidebarDefaultSize: 320,
  sidebarMinSize: 180,
}

const FILES: DemoSpec = {
  id: 'files',
  title: '文件',
  rows: ['packages/', 'apps/', 'docs/', 'README.md'],
  panes: 1,
  kind: 'demo.file',
  sidebarDefaultSize: 320,
  sidebarMinSize: 180,
}

const SANDBOX: DemoSpec = {
  id: 'sandboxes',
  title: '沙箱',
  rows: ['web-preview', 'pi-agent', 'browser-01'],
  panes: 2,
  kind: 'demo.sandbox',
  sidebarDefaultSize: 260,
  sidebarMinSize: 160,
}

export const SKELETON_MODULES: WorkspaceModule[] = [
  createDemoModule(TASKS),
  createDemoModule(FILES),
  createSharedContextModule(),
  createDemoModule(SANDBOX),
]
