import type { ProtocolCheck, StoredProtocolCheck } from '../client'
import { useMcp } from '../context'
import { useMutation } from '../lib/use-mutation'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

export function describeCheck(check?: StoredProtocolCheck) {
  if (!check) return '尚未完成协议检查'
  if (check.status === 'legacy') return '使用旧版 MCP 握手'
  if (check.status !== 'checked') return '旧版检查结果，请重新检查协议'
  return check.labels?.length ? `匹配 ${check.labels.length} 个标签` : '未匹配识别规则'
}

export function RecognitionBadges({ check }: { check?: StoredProtocolCheck }) {
  return check?.labels?.map((label, i) => <Badge key={i} className="min-w-0 break-all" variant="secondary" title="上次协议检查时匹配的标签">{label}</Badge>)
}

export function ProtocolCheckButton({ id, recheck, checked }: { id: string; recheck?: boolean; checked: (result: ProtocolCheck) => void }) {
  const { client } = useMcp()
  const check = useMutation()
  return <div className="min-w-0">
    <Button size="sm" icon="refresh" loading={check.busy} onClick={() => void check.run(signal => client.checkProtocol(id, signal), checked)}>
      {recheck ? '重新检查协议' : '检查协议'}
    </Button>
    {check.error && <p role="alert" className="mt-1 max-w-36 break-words text-xs text-err">{check.error}</p>}
  </div>
}
