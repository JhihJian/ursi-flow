import { useEffect, useState } from 'react'
import { Portal } from './Portal'
import { applyPortalConfig, parsePortalConfig, type PortalConfig } from './portal-config'
import { pluginManifest } from './plugin-manifest'
import type { PortalContext } from './portal-contract'
import type { PluginStatus } from './plugin-runtime'

const origin = window.location.origin
const pluginIds = pluginManifest.map(plugin => plugin.id)

function send(message: object) { window.parent.postMessage(message, origin) }
function onStatus(id: string, status: PluginStatus) { send({ type: 'portal-preview:status', id, status }) }

export function Preview({ context }: { context: PortalContext }) {
  const [config, setConfig] = useState<PortalConfig>()
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== window.parent || event.origin !== origin || event.data?.type !== 'portal-preview:config') return
      try { setConfig(parsePortalConfig(event.data.config, pluginIds, origin)) } catch { /* Keep the last valid preview. */ }
    }
    window.addEventListener('message', receive)
    send({ type: 'portal-preview:ready' })
    return () => window.removeEventListener('message', receive)
  }, [])
  if (!config) return null
  return <Portal context={applyPortalConfig(config, context, origin)} manifest={pluginManifest} config={config} preview onStatus={onStatus} />
}
