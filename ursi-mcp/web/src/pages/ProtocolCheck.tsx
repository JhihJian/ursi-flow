import type { ProtocolCheck } from '../client'
import { useMcp } from '../context'
import { useMutation } from '../lib/use-mutation'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

export const protocolLabels: Record<ProtocolCheck['status'], string> = {
  declaredV1: '服务自报支持执行器 v1',
  notDeclared: '未声明执行器协议',
  unsupportedVersion: '声明了不支持的执行器协议版本',
  invalidDeclaration: '执行器协议声明格式无效',
  legacy: '使用旧版 MCP 握手，未检查到协议声明',
}

export function ExecutorBadge({ check }: { check?: ProtocolCheck }) {
  if (check?.status !== 'declaredV1') return null
  return <Badge variant="secondary" title="上次检查时服务自报支持执行器 v1">执行器 v1</Badge>
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
