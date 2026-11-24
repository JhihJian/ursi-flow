import { Fragment, isValidElement, useId, useRef, useState, type ReactNode } from "react"
import "./page-frame.css"

export interface PageFrameProps {
  header: ReactNode
  main: ReactNode
  navigation?: { label: string; toggle: ReactNode; content: ReactNode; bottom?: ReactNode }
  aside?: ReactNode
  footer?: ReactNode
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

export function PageFrame({ header, main, navigation, aside, footer, asidePlacement = "right", skipLabel = "跳到主要内容" }: PageFrameProps) {
  const mainId = useId()
  const mainRef = useRef<HTMLElement>(null)
  const navigationId = useId()
  const navigationToggle = useRef<HTMLButtonElement>(null)
  const [navigationOpen, setNavigationOpen] = useState(false)
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
      <header className="ursi-page-frame__header">
        {navigation && <button
          ref={navigationToggle}
          className="ursi-page-frame__nav-toggle"
          type="button"
          aria-label={navigation.label}
          aria-controls={navigationId}
          aria-expanded={navigationOpen}
          title={navigation.label}
          onClick={() => setNavigationOpen(open => !open)}
        >{navigation.toggle}</button>}
        {header}
      </header>
      <div className="ursi-page-frame__columns" data-has-navigation={navigation ? "" : undefined}>
        {navigation && <nav
          className="ursi-page-frame__nav"
          id={navigationId}
          aria-label={navigation.label}
          data-open={navigationOpen ? "" : undefined}
          onKeyDown={event => {
            const toggle = navigationToggle.current
            if (!event.defaultPrevented && event.key === "Escape" && toggle?.getClientRects().length) {
              event.preventDefault()
              setNavigationOpen(false)
              toggle.focus()
            }
          }}
        >{navigation.content}
          {hasAsideContent(navigation.bottom) && <div className="ursi-page-frame__nav-bottom">{navigation.bottom}</div>}
        </nav>}
        <div className="ursi-page-frame__body" data-aside-placement={showAside ? asidePlacement : undefined}>
          <main className="ursi-page-frame__main" id={mainId} ref={mainRef} tabIndex={-1}>
            {main}
          </main>
          {showAside && <aside className="ursi-page-frame__aside">{aside}</aside>}
        </div>
      </div>
      {hasAsideContent(footer) && <footer className="ursi-page-frame__footer">{footer}</footer>}
    </div>
  )
}
