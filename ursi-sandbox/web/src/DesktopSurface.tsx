import { useEffect, useRef } from 'react'
import RFB from '@novnc/novnc/lib/rfb.js'

export default function DesktopSurface({ url, control, status }: {
  url: string
  control: boolean
  status: (state: 'connecting' | 'connected' | 'failed') => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const remote = useRef<RFB>(null)
  const controlRef = useRef(control)
  useEffect(() => {
    controlRef.current = control
    if (remote.current) remote.current.viewOnly = !control
  }, [control])
  useEffect(() => {
    const rfb = new RFB(host.current!, url)
    remote.current = rfb
    rfb.scaleViewport = true
    rfb.resizeSession = false
    rfb.viewOnly = !controlRef.current
    const connected = () => status('connected')
    const disconnected = () => status('failed')
    rfb.addEventListener('connect', connected)
    rfb.addEventListener('disconnect', disconnected)
    return () => {
      remote.current = null
      rfb.removeEventListener('connect', connected)
      rfb.removeEventListener('disconnect', disconnected)
      rfb.disconnect()
    }
  }, [url, status])
  return <div ref={host} aria-label="远程画面" className="h-[clamp(20rem,60dvh,44rem)] min-w-0 overflow-hidden rounded bg-black" />
}
