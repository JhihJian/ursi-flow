import { ArrowUpRight, PanelsTopLeft } from 'lucide-react'
import type { PluginContext, PortalContext } from '../portal-contract'

function WorkbenchEntry({ workbenchUrl }: PortalContext) {
  const label = <><PanelsTopLeft aria-hidden="true" size={17} /><span><strong>Workbench</strong><small>{workbenchUrl ? '工作项与工作包' : '未配置地址'}</small></span></>
  return workbenchUrl
    ? <a className="entry" href={workbenchUrl}>{label}<ArrowUpRight aria-hidden="true" size={15} /></a>
    : <div className="entry">{label}</div>
}

export function activate({ slots }: PluginContext) {
  slots.register('left-top', { id: 'workbench', Component: WorkbenchEntry })
}
