import type { ReactNode } from 'react'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'

export function GraphInspector({ map, title, icon, onClose, reset, children }: {
  map: boolean
  title: string
  icon: string
  onClose?: () => void
  reset?: { disabled: boolean; run: () => void }
  children: ReactNode
}) {
  return <aside aria-label={map ? 'Canvas Map 详情' : title}
    className={`min-w-0 overflow-hidden rounded-md border border-line bg-surface lg:flex lg:max-h-[var(--wb-canvas-height)] lg:flex-col ${map && reset ? 'lg:h-[var(--wb-canvas-height)]' : ''}`}>
    {map && <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line bg-elevated/40 px-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Icon name="workflow" size={16} />Canvas Map</h3>
      {reset && <Button size="sm" variant="ghost" className="w-7 px-0" icon="refresh" aria-label="重置布局" title="重置布局"
        disabled={reset.disabled} onClick={reset.run} />}
    </header>}
    <div className="scroll-area min-h-0 space-y-3 p-3 lg:overflow-y-auto">
      {(!map || onClose) && <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 shrink-0 text-txt3"><Icon name={icon} size={16} /></span>
        <h3 className="min-w-0 flex-1 break-words text-sm font-semibold text-txt">{title}</h3>
        {onClose && <Button size="sm" variant="ghost" className="w-7 shrink-0 px-0" icon="close" aria-label="关闭图详情" title="关闭图详情" onClick={onClose} />}
      </div>}
      {children}
    </div>
  </aside>
}

export function RelationNeighbors({ title, names }: { title: string; names: readonly string[] }) {
  return <div className="space-y-1">
    <h4 className="text-xs font-medium text-txt3">{title}</h4>
    {names.length ? <ul className="flex min-w-0 flex-wrap gap-1">
      {names.map((name, index) => <li key={index} className="max-w-full break-words rounded border border-line px-1.5 py-0.5 text-xs text-txt2">{name}</li>)}
    </ul> : <p className="text-xs text-txt3">无</p>}
  </div>
}
