import { useLocation } from 'react-router'

import { Button } from '@/shared/ui/button'

/** 业务域按需加载失败时留在应用壳内，允许整页重新打开目标地址。 */
export function RouteErrorAlert() {
  const location = useLocation()
  const target = `${location.pathname}${location.search}${location.hash}`

  return (
    <div role="alert" className="mb-6 rounded-xl border border-warn/30 bg-warn/10 p-5 text-sm text-txt">
      <p>页面加载失败，请检查网络后重试。</p>
      <Button className="mt-3" icon="refresh" onClick={() => { window.location.assign(target) }}>
        重新打开页面
      </Button>
    </div>
  )
}
