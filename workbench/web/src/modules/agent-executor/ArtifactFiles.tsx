import { useMemo, useState } from 'react'
import { directoryClient, type Entry } from '@/modules/directories/api'
import { ReadOnlyFile } from '@/modules/directories/ReadOnlyFile'
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
    {path && <ReadOnlyFile key={path} directory={directory} path={path} />}
  </section>
}
