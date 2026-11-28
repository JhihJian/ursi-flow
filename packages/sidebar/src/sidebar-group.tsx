import { createContext, useContext, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { cx } from './cx'
import { SidebarRow } from './sidebar-row'

/** 当前所在分组的深度。SidebarGroup 读它决定自己的缩进，往下传时 +1。 */
const DepthContext = createContext(0)

export interface SidebarGroupProps {
  /** 是否展开子级。受控：状态由调用方持有，组件只渲染。 */
  open: boolean
  /** 点击父行或 chevron 时触发，调用方在这里翻转 open。 */
  onToggle: () => void
  /** 父行内容，传给 SidebarRow 的 label。 */
  label: ReactNode
  /** 父行说明，传给 SidebarRow 的 meta。 */
  meta?: ReactNode
  active?: boolean
  title?: string
  onContextMenu?: (event: MouseEvent) => void
  /** 父行的额外类名。 */
  className?: string
  /** 覆盖自动推断的嵌套深度。根级分组不传，嵌套在另一个 SidebarGroup 里时自动 +1。 */
  depth?: number
  /** 子级。通常是 SidebarRow 或另一个 SidebarGroup。 */
  children?: ReactNode
}

/**
 * 可折叠的侧边栏分组：父行 + 子级列表。只管三件事：chevron、缩进、参考线。
 * 展开状态由调用方持有（受控），子级是什么由调用方决定。
 *
 * 父行是 div（SidebarRow as="div"），因为 chevron 是 button，HTML 不允许 button 嵌套。
 */
export function SidebarGroup({ open, onToggle, label, meta, active, title, onContextMenu, className, depth, children }: SidebarGroupProps) {
  const inherited = useContext(DepthContext)
  const level = depth ?? inherited
  return (
    <DepthContext value={level + 1}>
      <div className={cx('sb-group', open && 'is-open')} style={{ '--sb-depth': level } as CSSProperties}>
        <SidebarRow
          as="div"
          className={className}
          active={active}
          title={title}
          onClick={onToggle}
          onContextMenu={onContextMenu}
          leading={
            <button
              type="button"
              className={cx('sb-chevron', open && 'is-open')}
              aria-label={open ? '收起' : '展开'}
              aria-expanded={open}
              onClick={(event) => {
                event.stopPropagation()
                onToggle()
              }}
            >
              ▸
            </button>
          }
          label={label}
          meta={meta}
        />
        {open ? <div className="sb-group-children">{children}</div> : null}
      </div>
    </DepthContext>
  )
}
