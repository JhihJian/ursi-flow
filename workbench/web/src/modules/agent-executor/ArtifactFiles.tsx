import { useMemo, useState } from 'react'
import { directoryClient, type Directory, type Entry } from '@/modules/directories/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'

export function ArtifactFiles({ id }: { id: string }) {
  const directory = useMemo(() => directoryClient(id), [id])
  const tree = useResource(signal => directory.tree(signal), [] as Entry[])
  const [path, setPath] = useState('')
  const files = tree.data.filter(e => e.kind === 'file')
  return <section aria-label="只读文件制品" className="space-y-2">
    <h4 className="font-medium">文件制品（只读）</h4>
    {tree.loading ? <p>正在读取制品目录…</p> : tree.error ? <p role="alert">{tree.error} <Button size="sm" onClick={tree.reload}>重读目录</Button></p>
      : !files.length ? <p className="text-txt3">暂无文件制品。</p>
      : <ul>{files.map(file => <li key={file.path}>
        <button type="button" className="break-all text-left text-accent-2 underline" aria-pressed={path === file.path} onClick={() => setPath(file.path)}>{file.path}</button>
      </li>)}</ul>}
    {path && <ArtifactFile key={path} directory={directory} path={path} />}
  </section>
}

type FileData = { blob: Blob; preview: string }

function ArtifactFile({ directory, path }: { directory: Pick<Directory, 'read'>; path: string }) {
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

  if (file.loading) return <p>正在读取 {path}…</p>
  if (file.error) return <p role="alert">{file.error} <Button size="sm" onClick={file.reload}>重读文件</Button></p>
  return <div className="space-y-2">
    <pre aria-label={`${path} 内容`} className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-elevated p-3 text-xs">{file.data?.preview}</pre>
    <Button size="sm" icon="download" onClick={download}>下载文件</Button>
  </div>
}
