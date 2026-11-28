/**
 * 组件预览页：每一栏是一种接法，栏头写明用了哪些口子。
 * 改 style.css 或组件后刷新即见。样式加载顺序与真实应用一致：外壳变量 → 本包 → 页面自己的排版。
 */
import { StrictMode, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMenu, SidebarGroup, SidebarRow, type MenuItem, type MenuState } from '../src/index'
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
    <Frame title="基础" note="active 切换、onClick 选中、title 悬停提示、没有说明就是单行">
      {[1, 2, 3].map((index) => (
        <SidebarRow
          key={index}
          active={active === index}
          onClick={() => setActive(index)}
          title={`第 ${index} 行`}
          label={index === 2 ? '名字很长很长很长很长很长会被截掉' : `第 ${index} 行`}
        />
      ))}
    </Frame>
  )
}

function WithMeta() {
  return (
    <Frame title="说明行" note="meta 在主标签下方，超出截断。pi 会话、flow、todo、fs 都是这个">
      <SidebarRow label="项目 A" meta="~/dev/ursi-flow · 3 tasks / 2h 15m" />
      <SidebarRow label="项目 B" active meta={<span>模型 · 3 节点 · 2 变量</span>} />
      <SidebarRow label="项目 C" meta="说明文字很长很长很长很长很长很长会被截掉" />
      <SidebarRow
        label="目录 D"
        leading={<span className="pv-icon">▣</span>}
        trailing={<span title="未就绪">!</span>}
        meta="/mnt/data/some/very/long/path"
      />
    </Frame>
  )
}

function Tree() {
  const [open, setOpen] = useState<Record<string, boolean>>({ a: true, 'a-1': true })
  const [active, setActive] = useState<string | null>(null)
  const toggle = (key: string) => setOpen((current) => ({ ...current, [key]: !current[key] }))
  return (
    <Frame title="分组树" note="SidebarGroup 管折叠、缩进、参考线。open 受控。点父行或 chevron 都翻转。可嵌套">
      <SidebarGroup
        open={!!open.a}
        onToggle={() => toggle('a')}
        label="连接 dev-01"
        meta="ssh dev-01 · 2 会话"
        active={active === 'a'}
        onContextMenu={(event) => {
          event.preventDefault()
          setActive('a')
        }}
      >
        <SidebarRow label="main" meta="默认会话" active={active === 'a-main'} onClick={() => setActive('a-main')} />
        <SidebarGroup
          open={!!open['a-1']}
          onToggle={() => toggle('a-1')}
          label="worker"
          meta="2 clients attached"
          active={active === 'a-1'}
        >
          <SidebarRow label="window 0" meta="vim" active={active === 'a-1-0'} onClick={() => setActive('a-1-0')} />
          <SidebarRow label="window 1" meta="tail -f" active={active === 'a-1-1'} onClick={() => setActive('a-1-1')} />
        </SidebarGroup>
      </SidebarGroup>
      <SidebarGroup open={!!open.b} onToggle={() => toggle('b')} label="连接 dev-02（收起）" active={active === 'b'} onContextMenu={(event) => { event.preventDefault(); setActive('b') }}>
        <SidebarRow label="main" />
      </SidebarGroup>
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
        SidebarRow：主标签 + 说明（可选），只开 onClick / onContextMenu / rowRef 三个口子，业务状态拼进 className。
        SidebarGroup：父行 + 子级，管折叠、缩进、参考线，open 受控。各栏外层是 240px 宽的侧栏模拟。
      </p>
      <div className="pv-grid">
        <Basic />
        <WithMeta />
        <Tree />
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
