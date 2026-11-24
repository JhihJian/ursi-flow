import type { ReactNode } from 'react'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'

export function InspectorHeader({ title, icon, onClose, closeLabel = '关闭图详情' }: {
  title: string; icon: string; onClose?: () => void; closeLabel?: string
}) {
  return <header className="flex min-h-10 items-center gap-2 border-b border-line bg-elevated/40 px-3 py-1">
    <Icon name={icon} size={16} className="shrink-0 text-txt3" />
    <h3 className="min-w-0 flex-1 break-words text-sm font-semibold text-txt">{title}</h3>
    {onClose && <Button size="sm" variant="ghost" className="w-7 shrink-0 px-0" icon="close" aria-label={closeLabel} title={closeLabel} onClick={onClose} />}
  </header>
}

export function GraphInspector({ map, title, icon, onClose, children }: {
  map: boolean; title: string; icon: string; onClose?: () => void; children: ReactNode
}) {
  return <aside aria-label={map ? 'Canvas Map 详情' : title} className="min-w-0">
    <InspectorHeader title={title} icon={icon} onClose={onClose} />
    <div className="space-y-3 p-3">{children}</div>
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
