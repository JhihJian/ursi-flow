import type { ReactNode } from 'react'
import { useAppStore } from '../../../pi-store'

/**
 * 分区布局骨架：左列表 + 右详情 + 底部状态行，对齐开源 pi-web 设置页的
 * split view 结构（只取骨架职责，按钮/开关等皮肤仍用本仓 .btn/.switch）。
 *
 * 高度链约定见 module.css 头注释：本组组件是「滚动层」的直接宿主，
 * panel-list 与 panel-detail 各自内滚，panel-footer 固定在底部不滚。
 */

/** 一个分区页：左列表、右详情、底部状态行由调用方按需组合。 */
export function SectionSplit({
  list,
  detail,
  footer,
}: {
  list: ReactNode
  detail: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="panel-split">
      <div className="panel-body">
        <div className="panel-list">
          {list}
          <div className="panel-list-fill" aria-hidden />
        </div>
        <div className="panel-detail">{detail}</div>
      </div>
      {footer ? <div className="panel-footer">{footer}</div> : null}
    </div>
  )
}

/** 左列表列头：标题 + 右侧动作区（过滤框、新增按钮）。 */
export function SectionListHead({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="panel-list-head">
      <span className="panel-list-title">{title}</span>
      {actions ? <span className="field-row">{actions}</span> : null}
    </div>
  )
}

/** 左列表行：主标题 + 副行 + 右侧徽标；选中态走 aria-current，mark 驱动行首状态点。 */
export function SectionListItem({
  active,
  title,
  sub,
  badges,
  disabled,
  mark,
  onClick,
}: {
  active: boolean
  title: ReactNode
  sub?: ReactNode
  badges?: ReactNode
  disabled?: boolean
  /** 行首状态点：ok 绿 / off 灭 / warn 黄；不传保持默认灰。 */
  mark?: 'ok' | 'off' | 'warn'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="list-item"
      aria-current={active || undefined}
      data-mark={mark}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="list-item-mark" aria-hidden />
      <span className="list-item-main">
        <span className="list-item-title">{title}</span>
        {sub ? <span className="list-item-sub">{sub}</span> : null}
      </span>
      {badges ? <span className="list-item-badges">{badges}</span> : null}
    </button>
  )
}

/** 左列表底部固定动作（如「新增」），视觉上贴住列表末尾。 */
export function SectionListAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="list-item list-item-action" onClick={onClick}>
      <span className="list-item-mark" aria-hidden />
      <span className="list-item-title">{children}</span>
    </button>
  )
}

/** 右详情列头：标题 + 元信息 + 动作区。 */
export function SectionDetailHead({
  title,
  meta,
  actions,
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="panel-detail-head">
      <div className="panel-detail-head-main">
        <h2 className="detail-title">{title}</h2>
        {meta ? <span className="detail-meta">{meta}</span> : null}
      </div>
      {actions ? <div className="field-row">{actions}</div> : null}
    </div>
  )
}

/**
 * 底部状态行：左侧提示文字 + 当前写操作状态，右侧动作或说明。
 *
 * 写操作状态（runWrite 写入 store 的 busy/ok/error）在这里统一渲染：
 * 独立入口的全局 footer 随旧 App.tsx 移除后，这里是唯一显示位置。
 */
export function SectionFooterNote({ note, aside }: { note?: ReactNode; aside?: ReactNode }) {
  const footer = useAppStore((s) => s.footer)
  return (
    <>
      {footer.message ? (
        <span className={`footer-msg ${footer.kind === 'ok' ? 'ok' : footer.kind === 'error' ? 'error' : ''}`}>
          {footer.message}
        </span>
      ) : note ? (
        <span className="footer-msg">{note}</span>
      ) : null}
      <span className="spacer" />
      {aside}
    </>
  )
}
