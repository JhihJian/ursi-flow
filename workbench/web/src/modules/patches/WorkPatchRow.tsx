import { Link } from 'react-router'
import { Button } from '@/shared/ui/button'
import type { Patch } from './api'
import { patchPath } from './PatchModel'

const results = { not_started: '暂无结果', running: '执行中', succeeded: '成功', failed: '失败' }
const localTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

export function WorkPatchRow({ patch }: { patch: Patch }) {
  const date = patch.createdAt == null ? null : new Date(patch.createdAt * 1000)
  const status = patch.executionStatus
  return <li className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
    <div className="min-w-0 basis-full lg:flex-1">
      <Link className="break-words font-medium text-txt hover:underline" to={patchPath('work', patch.id)}>{patch.name}</Link>
      <small className="mt-1 block break-all font-mono text-xs text-txt3">{patch.id}</small>
    </div>
    <dl className="grid min-w-0 flex-1 basis-full grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4 lg:basis-auto lg:flex-[3]">
      <div><dt className="text-txt3">来源</dt><dd>{patch.source === 'manual' ? '手动创建' : patch.source || '未记录'}</dd></div>
      <div><dt className="text-txt3">创建时间</dt><dd>{date && Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()}>{localTime.format(date)}</time> : '未记录'}</dd></div>
      <div><dt className="text-txt3">是否已执行</dt><dd>{status === 'not_started' ? '未执行' : status && status in results ? '已执行' : '未记录'}</dd></div>
      <div><dt className="text-txt3">执行结果</dt><dd>{status ? results[status] ?? '未知' : '未记录'}</dd></div>
    </dl>
    <Button size="sm" variant="outline" disabled title="暂无执行详情链接">执行详情</Button>
  </li>
}
