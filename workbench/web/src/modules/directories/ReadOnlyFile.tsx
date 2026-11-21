import type { Directory } from './api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'

type FileData = { blob: Blob; preview: string }

export function ReadOnlyFile({ directory, path }: { directory: Pick<Directory, 'read'>; path: string }) {
  const file = useResource<FileData | null>(async signal => {
    const blob = await directory.read(path, signal)
    if (blob.size > 256 * 1024) return { blob, preview: '文件较大，请下载查看。' }
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob)
    })
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (!text.includes('\0')) return { blob, preview: text || '空文件' }
    } catch { /* 非 UTF-8 文件保留原字节供下载。 */ }
    return { blob, preview: '二进制文件，请下载查看。' }
  }, null)

  function download() {
    if (!file.data) return
    const url = URL.createObjectURL(file.data.blob)
    const link = document.createElement('a')
    link.href = url
    link.download = path.split('/').pop() || path
    try { link.click() } finally { window.setTimeout(() => URL.revokeObjectURL(url), 0) }
  }

  if (file.loading) return <p role="status">正在读取 {path}…</p>
  if (file.error) return <p role="alert">{file.error} <Button size="sm" onClick={file.reload}>重读文件</Button></p>
  return <div className="space-y-2">
    <pre aria-label={`${path} 内容`} className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-elevated p-3 text-xs">{file.data?.preview}</pre>
    <Button size="sm" icon="download" onClick={download}>下载文件</Button>
  </div>
}
