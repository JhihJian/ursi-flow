import { Button } from '@/shared/ui/button'
import type { TextFileState } from './use-text-file'

export interface SaveBarProps {
  file: TextFileState
  /** 内容不合法等外部原因导致暂不能保存。 */
  disabled?: boolean
  saveLabel?: string
}

/** 显式保存的公共操作区：状态提示、放弃修改与保存。 */
export function SaveBar({ file, disabled = false, saveLabel = '保存' }: SaveBarProps) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      {file.dirty ? (
        <span className="rounded-md border border-warn/40 px-2 py-0.5 text-[11px] text-warn">未保存</span>
      ) : file.saved ? (
        <span role="status" className="rounded-md border border-ok/40 px-2 py-0.5 text-[11px] text-ok">已保存</span>
      ) : null}
      <Button size="sm" variant="ghost" disabled={!file.dirty || file.saving} onClick={file.reset}>放弃修改</Button>
      <Button
        size="sm"
        variant="primary"
        icon="save"
        loading={file.saving}
        disabled={!file.dirty || disabled}
        onClick={() => { void file.save() }}
      >{saveLabel}</Button>
    </div>
  )
}
