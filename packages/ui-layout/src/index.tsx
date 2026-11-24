import { Fragment, isValidElement, useId, useRef, type ReactNode } from "react"
import "./page-frame.css"

export interface PageFrameProps {
  header: ReactNode
  main: ReactNode
  aside?: ReactNode
  asidePlacement?: "right" | "below"
  skipLabel?: string
}

function hasAsideContent(node: ReactNode): boolean {
  if (node == null || typeof node === "boolean") return false
  if (typeof node === "string") return node.trim().length > 0
  if (Array.isArray(node)) return node.some(hasAsideContent)
  if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) {
    return hasAsideContent(node.props.children)
  }
  return true
}

export function PageFrame({ header, main, aside, asidePlacement = "right", skipLabel = "跳到主要内容" }: PageFrameProps) {
  const mainId = useId()
  const mainRef = useRef<HTMLElement>(null)
  const showAside = hasAsideContent(aside)

  return (
    <div className="ursi-page-frame">
      <a
        className="ursi-page-frame__skip"
        href={`#${mainId}`}
        onClick={(event) => {
          if (mainRef.current) {
            event.preventDefault()
            mainRef.current.focus()
          }
        }}
      >
        {skipLabel}
      </a>
      <header className="ursi-page-frame__header">{header}</header>
      <div className="ursi-page-frame__body" data-aside-placement={showAside ? asidePlacement : undefined}>
        <main className="ursi-page-frame__main" id={mainId} ref={mainRef} tabIndex={-1}>
          {main}
        </main>
        {showAside && <aside className="ursi-page-frame__aside">{aside}</aside>}
      </div>
    </div>
  )
}
