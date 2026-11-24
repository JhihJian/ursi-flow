import * as React from 'react'

// 极简折叠：受控/非受控均可，展开状态通过 context 传给 trigger/content。

const CollapsibleContext = React.createContext<{
  open: boolean
  toggle: () => void
} | null>(null)

function useCollapsible() {
  const ctx = React.useContext(CollapsibleContext)
  if (!ctx) throw new Error('CollapsibleTrigger/Content 必须放在 Collapsible 内')
  return ctx
}

export function Collapsible({
  open,
  onOpenChange,
  className,
  children,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  children: React.ReactNode
}) {
  const [internal, setInternal] = React.useState(false)
  const isOpen = open ?? internal
  const toggle = React.useCallback(() => {
    const next = !isOpen
    if (open === undefined) setInternal(next)
    onOpenChange?.(next)
  }, [isOpen, open, onOpenChange])

  return (
    <CollapsibleContext.Provider value={{ open: isOpen, toggle }}>
      <div className={className}>{children}</div>
    </CollapsibleContext.Provider>
  )
}

export function CollapsibleTrigger({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  const { toggle } = useCollapsible()
  return (
    <button
      type="button"
      className={className ?? 'collapsible-trigger'}
      onClick={toggle}
    >
      {children}
    </button>
  )
}

export function CollapsibleContent({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  const { open } = useCollapsible()
  if (!open) return null
  return <div className={className ?? 'collapsible-content'}>{children}</div>
}
