import { Button } from '@/shared/ui/button'

export interface FileErrorProps {
  message: string
  onRetry: () => void
}

/** 锚点文件读取失败时的提示，保留重试入口。 */
export function FileError({ message, onRetry }: FileErrorProps) {
  return <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-err/30 bg-err/10 px-3 py-2 text-xs text-err">
    <span className="min-w-0 flex-1 break-words">{message}</span>
    <Button size="sm" variant="ghost" icon="refresh" onClick={onRetry}>重试</Button>
  </div>
}
