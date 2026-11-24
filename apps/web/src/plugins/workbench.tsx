import { ArrowUpRight, PanelsTopLeft } from 'lucide-react'
import type { PluginContext, PortalContext } from '../portal-contract'

function WorkbenchEntry({ workbenchUrl }: PortalContext) {
  const label = <><PanelsTopLeft aria-hidden="true" size={20} /><span><strong>Workbench</strong><small>工作项与工作包</small></span></>
  return workbenchUrl
    ? <a className="entry" href={workbenchUrl}>{label}<ArrowUpRight aria-hidden="true" size={17} /></a>
    : <div className="entry">{label}<small>未配置地址</small></div>
}

export function activate({ slots }: PluginContext) {
  slots.register('home.entries', { id: 'workbench', Component: WorkbenchEntry })
}
