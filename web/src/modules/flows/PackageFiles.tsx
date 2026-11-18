import { useState } from 'react'
import type { FlowFiles } from '@/shared/api/types'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Textarea } from '@/shared/ui/textarea'

export function PackageFiles({ files, onChange }: { files: FlowFiles; onChange: (files: FlowFiles) => void }) {
  const [selected, select] = useState('FLOW.md')
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  function add() {
    const name = path.trim()
    const parts = name.split('/')
    if (!['scripts', 'references'].includes(parts[0]!) || parts.length < 2 || parts.some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) {
      setError('请输入 scripts/ 或 references/ 下的相对文件路径。'); return
    }
    if (Object.hasOwn(files, name)) { setError('文件已存在。'); return }
    onChange({ ...files, [name]: '' }); select(name); setPath(''); setError('')
  }
  function remove() {
    const next = { ...files }; delete next[selected]; onChange(next); select('FLOW.md')
  }
  return <section className="space-y-3">
    <h2 className="font-semibold">包文件</h2>
    <div className="flex flex-wrap gap-2">{Object.keys(files).map(name => <button key={name} type="button" aria-pressed={selected === name} className={`max-w-full break-all rounded-md border px-3 py-1.5 text-sm ${selected === name ? 'border-accent bg-accent-dim' : 'border-line'}`} onClick={() => select(name)}>{name}</button>)}</div>
    <label className="field"><span className="field-label break-all">{selected}</span><Textarea className="min-h-80 font-mono" spellCheck={false} value={files[selected]} onChange={e => onChange({ ...files, [selected]: e.target.value })} /></label>
    <div className="flex flex-wrap items-center gap-2"><Input className="max-w-sm" aria-label="新增文件路径" placeholder="references/guide.md" value={path} onChange={e => setPath(e.target.value)} />
      <Button icon="plus" onClick={add}>添加文件</Button>{selected !== 'FLOW.md' && <Button variant="danger" onClick={remove}>移除当前文件</Button>}
    </div>{error && <p role="alert" className="text-sm text-err">{error}</p>}
  </section>
}
