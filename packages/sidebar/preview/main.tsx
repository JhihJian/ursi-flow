/**
 * 组件预览页：每一栏是一种接法，栏头写明用了哪些口子。
 * 改 style.css 或组件后刷新即见。样式加载顺序与真实应用一致：外壳变量 → 本包 → 页面自己的排版。
 */
import { StrictMode, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMenu, SidebarRow, type MenuItem, type MenuState } from '../src/index'
import '../../workspace-shell/src/shell.css'
import '../src/style.css'
import './preview.css'

function Frame({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="pv-frame">
      <h2>{title}</h2>
      <p>{note}</p>
      <div className="pv-list">{children}</div>
    </section>
  )
}

function Basic() {
  const [active, setActive] = useState(2)
  return (
    <Frame title="基础" note="active 切换、onClick 选中、title 悬停提示、meta 靠右截断">
      {[1, 2, 3].map((index) => (
        <SidebarRow
          key={index}
          active={active === index}
          onClick={() => setActive(index)}
          title={`第 ${index} 行`}
          label={index === 2 ? '名字很长很长很长很长很长会被截掉' : `第 ${index} 行`}
          meta={index === 3 ? '附加文字也很长很长很长很长' : '12:30'}
        />
      ))}
    </Frame>
  )
}

function Stack() {
  return (
    <Frame title="stack 布局" note="标签在上，meta 与 children 在下。flow、pi 会话、todo、fs 用这种">
      <SidebarRow layout="stack" label="项目 A">
        <span className="pv-dir">~/dev/ursi-flow</span>
        <span className="pv-meta">3 tasks / 2h 15m</span>
      </SidebarRow>
      <SidebarRow layout="stack" active label="项目 B" meta={<span>模型 · 3 节点</span>} />
      <SidebarRow layout="stack" label="项目 C" meta="只有 meta 没有 children" />
    </Frame>
  )
}

function LeadingTrailing() {
  const [open, setOpen] = useState(true)
  return (
    <Frame title="leading / trailing" note="ssh 的折叠按钮、fs 的图标与未就绪标记放这两个位置。行里嵌按钮时根元素用 as=div">
      <SidebarRow
        as="div"
        label="连接 dev-01"
        title="ssh dev-01"
        leading={
          <button
            type="button"
            className={open ? 'pv-chevron open' : 'pv-chevron'}
            aria-label={open ? '收起' : '展开'}
            onClick={(event) => {
              event.stopPropagation()
              setOpen(!open)
            }}
          >
            ▸
          </button>
        }
      />
      {open ? (
        <>
          <SidebarRow className="pv-child" label="main" meta="默认会话" />
          <SidebarRow className="pv-child" active label="worker" meta="● 2 clients attached" />
        </>
      ) : null}
      <SidebarRow layout="stack" label="目录 C" leading={<span className="pv-icon">▣</span>} trailing={<span title="未就绪">!</span>}>
        <span className="pv-dir">/mnt/data</span>
      </SidebarRow>
    </Frame>
  )
}

function ContextMenuDemo() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const items: MenuItem[] = [
    { label: '打开', onSelect: () => setPicked('打开') },
    { label: '重命名', onSelect: () => setPicked('重命名') },
    { label: '不可用', disabled: true, reason: '演示 disabled', onSelect: () => {} },
    {
      label: '删除',
      danger: true,
      onSelect: () => {
        const rect = document.querySelector('[data-demo-id="1"]')?.getBoundingClientRect()
        const host = document.querySelector('.pv-menu-host')!.getBoundingClientRect()
        setMenu({
          x: (rect?.left ?? 0) - host.left,
          y: (rect?.bottom ?? 0) - host.top + 4,
          heading: '删除「第 1 行」？',
          items: [
            { label: '删除', danger: true, onSelect: () => setPicked('已删除') },
            { label: '取消', onSelect: () => {} },
          ],
        })
      },
    },
  ]
  return (
    <Frame title="右键菜单" note="在行上右键。菜单 portal 进 .pv-menu-host，坐标相对它。删除是二次确认">
      <div className="pv-menu-host" onContextMenu={(event) => event.preventDefault()}>
        {[1, 2].map((index) => (
          <SidebarRow
            key={index}
            data-demo-id={index}
            label={`第 ${index} 行`}
            meta={picked ?? undefined}
            onClick={() => setPicked(`点击了第 ${index} 行`)}
            onContextMenu={(event) => {
              event.preventDefault()
              const host = event.currentTarget.closest('.pv-menu-host')!.getBoundingClientRect()
              setMenu({ x: event.clientX - host.left, y: event.clientY - host.top, items })
            }}
          />
        ))}
        <ContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          container={document.querySelector('.pv-menu-host')}
        />
      </div>
      <p className="pv-result">上次操作：{picked ?? '无'}</p>
    </Frame>
  )
}

function App() {
  return (
    <main className="pv-page">
      <h1>@ursi/sidebar</h1>
      <p className="pv-lead">
        SidebarRow 根元素是 button，只开 onClick / onContextMenu / rowRef 三个口子，业务状态拼进 className。
        左侧竖线与 hover 灰底由包提供，各栏外层是 240px 宽的侧栏模拟。
      </p>
      <div className="pv-grid">
        <Basic />
        <Stack />
        <LeadingTrailing />
        <ContextMenuDemo />
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
