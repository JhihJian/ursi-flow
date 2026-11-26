import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type {
  ModuleSidebarProps,
  Selection,
  ShellHandle,
  WorkspaceModule,
} from '@ursi/workspace-shell'
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
  /** 组合根注入的跨模块能力；示例里由文件模块提供。 */
  openRootInFiles?: (root: string) => Promise<{ id: string; label: string }>
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
      ...(spec.openRootInFiles
        ? [
            {
              id: `${spec.id}.open-project-in-files`,
              label: '在文件模块打开项目目录',
              appliesTo: (selection: Selection | null) =>
                selection?.kind === spec.kind,
              disabledReason: (_selection: Selection, shell: ShellHandle) => {
                if (!shell.enabled('files')) return '文件模块未在当前 profile 中启用'
                return null
              },
              confirm: '会在文件模块里登记并打开该目录。继续？',
              run: async (selection: Selection, shell: ShellHandle) => {
                const root = `/projects/${selection.id}`
                await spec.openRootInFiles!(root)
                shell.reveal('files')
              },
            },
          ]
        : []),
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

/**
 * 文件模块：演示「工厂导出具名命令 + 工厂私有状态」的正确形状。
 * 命令与状态都归工厂，其它模块只能拿到命令返回的普通值，拿不到 store。
 */
function createFilesModule(): WorkspaceModule & {
  commands: { openRoot: (root: string) => Promise<{ id: string; label: string }> }
} {
  const opened: string[] = []
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const read = () => opened.join('|')
  const append = (root: string) => {
    if (opened.includes(root)) {
      // 已登记则只换到最前面，模拟「激活已有目录」。
      opened.splice(opened.indexOf(root), 1)
    }
    opened.unshift(root)
    for (const listener of listeners) listener()
  }

  const commands = {
    openRoot: async (root: string) => {
      append(root)
      return { id: root, label: root.split('/').filter(Boolean).pop() ?? root }
    },
  }

  function useOpenedRoots(): string[] {
    const key = useSyncExternalStore(subscribe, read, read)
    return key ? key.split('|') : []
  }

  const Sidebar = ({ collapsed, collapse, expand }: ModuleSidebarProps) => {
    const roots = useOpenedRoots()
    return (
      <SidebarFrame
        title="文件"
        collapsed={collapsed}
        collapse={collapse}
        expand={expand}
        items={[{ label: '目录', value: String(roots.length) }]}
      >
        {roots.length === 0 ? (
          <p className="sk-hint sk-hint-pad">
            还没有目录。切到「任务」，选中一项后用控制面板的「在文件模块打开项目目录」。
          </p>
        ) : (
          <ul className="sk-list">
            {roots.map((root) => (
              <li key={root}>
                <span className="sk-row sk-row-static" title={root}>
                  {root}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SidebarFrame>
    )
  }

  const Workspace = () => {
    const roots = useOpenedRoots()
    return (
      <div className="sk-workspace">
        <div className="sk-workspace-grid" data-panes={1}>
          <div className="sk-block">
            <span className="sk-block-label">
              {roots[0] ? `文件 · ${roots[0]}` : '文件 · 工作区'}
            </span>
            <span className="sk-block-size">
              {roots.length > 0 ? `已登记目录 ${roots.length}` : '由其它模块经命令写入'}
            </span>
          </div>
        </div>
      </div>
    )
  }

  return {
    commands,
    id: 'files',
    title: '文件',
    Sidebar,
    Workspace,
    context: {
      Status: () => {
        const roots = useOpenedRoots()
        return <span>文件 {roots.length}</span>
      },
    },
    sidebarDefaultSize: 320,
    sidebarMinSize: 180,
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

const SANDBOX: DemoSpec = {
  id: 'sandboxes',
  title: '沙箱',
  rows: ['web-preview', 'pi-agent', 'browser-01'],
  panes: 2,
  kind: 'demo.sandbox',
  sidebarDefaultSize: 260,
  sidebarMinSize: 160,
}

/** 组合根：组合根是唯一同时看见两个模块的地方，跨模块的边在这里显式接线。 */
const files = createFilesModule()

/**
 * 跨模块依赖说明，仅用于预览页展示；真实工程里这条边就是 registry.tsx 的一行 import。
 */
export const SKELETON_WIRES = [
  { from: '任务', to: '文件', capability: 'openRootInFiles → files.commands.openRoot' },
]

export const SKELETON_MODULES: WorkspaceModule[] = [
  createDemoModule({ ...TASKS, openRootInFiles: files.commands.openRoot }),
  files,
  createSharedContextModule(),
  createDemoModule(SANDBOX),
]
