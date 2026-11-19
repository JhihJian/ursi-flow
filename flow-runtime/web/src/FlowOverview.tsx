import { useMemo, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, FileCode2, FilePlus2, FileText, Folder, Trash2 } from 'lucide-react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { MarkdownEditor } from './Markdown'
import { cn } from './lib/utils'
import type { FlowFiles } from './data'

type Files = Map<string, { path: string; children?: Files }>

function fileTree(paths: string[]): Files {
  const root: Files = new Map()
  for (const path of paths.sort((a, b) => a.localeCompare(b))) {
    let branch = root
    const parts = path.split('/')
    for (const [index, name] of parts.entries()) {
      if (index === parts.length - 1) {
        branch.set(name, { path })
      } else {
        let folder = branch.get(name)?.children
        if (!folder) {
          folder = new Map()
          branch.set(name, { path: parts.slice(0, index + 1).join('/'), children: folder })
        }
        branch = folder
      }
    }
  }
  return root
}

function FileTree({ entries, selected, collapsed, onToggle, onOpen }: {
  entries: Files
  selected: string
  collapsed: Set<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  return <ul className="space-y-0.5">
    {[...entries].map(([name, { path, children }]) => {
      const expanded = !collapsed.has(path)
      const active = !children && selected === path
      const Icon = children ? Folder : name.endsWith('.md') ? FileText : FileCode2
      return <li key={path}>
        <Button
          variant="ghost"
          size="sm"
          className={cn('w-full min-w-0 justify-start px-1.5 font-mono', active && 'bg-accent-dim text-accent-2')}
          title={path}
          aria-label={path}
          aria-expanded={children ? expanded : undefined}
          aria-current={active ? 'true' : undefined}
          onClick={() => children ? onToggle(path) : onOpen(path)}
        >
          {children ? (expanded ? <ChevronDown /> : <ChevronRight />) : <span className="size-4 shrink-0" />}
          <Icon />
          <span className="truncate">{name}</span>
        </Button>
        {children && expanded && (
          <div className="ml-3 border-l border-line pl-1">
            <FileTree entries={children} {...{ selected, collapsed, onToggle, onOpen }} />
          </div>
        )}
      </li>
    })}
  </ul>
}

export function FlowOverview({ files, selected, fileOpen, onBack, onOpen, onAdd, onRemove, onChange }: {
  files: FlowFiles
  selected: string
  fileOpen: boolean
  onBack: () => void
  onOpen: (path: string) => boolean
  onAdd: (path: string) => string | undefined
  onRemove: (path: string) => void
  onChange: (path: string, text: string) => void
}) {
  const entries = useMemo(() => fileTree(Object.keys(files)), [files])
  const [newPath, setNewPath] = useState('')
  const [collapsed, setCollapsed] = useState(new Set<string>())

  function reveal(path: string) {
    setCollapsed((current) => new Set([...current].filter((folder) => !path.startsWith(`${folder}/`))))
  }

  function open(path: string) {
    if (onOpen(path)) reveal(path)
  }

  return (
    <div className="grid min-w-0 overflow-hidden rounded-lg border border-line bg-surface md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside aria-label="包文件" className={cn('min-w-0 md:block md:border-r md:border-line', fileOpen && 'hidden')}>
        <div className="border-b border-line px-2 py-2">
          <h2 className="px-1.5 text-xs font-medium">包文件</h2>
          <form className="mt-2 flex items-center gap-1" onSubmit={(event) => {
            event.preventDefault()
            const path = onAdd(newPath)
            if (!path) return
            setNewPath('')
            reveal(path)
          }}>
            <Input
              aria-label="新增文件路径"
              className="h-7 min-w-0 px-2 font-mono text-xs"
              placeholder="references/checklist.md"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
            />
            <Button type="submit" size="icon-sm" variant="ghost" className="shrink-0" aria-label="新增文件" title="新增文件" disabled={!newPath.trim()}>
              <FilePlus2 />
            </Button>
          </form>
        </div>
        <div className="max-h-[70vh] overflow-auto p-2">
          <FileTree
            entries={entries}
            selected={selected}
            collapsed={collapsed}
            onToggle={(path) => setCollapsed((current) => {
              const next = new Set(current)
              if (!next.delete(path)) next.add(path)
              return next
            })}
            onOpen={open}
          />
        </div>
      </aside>
      <section aria-label="文件编辑区" className={cn('min-w-0 md:block', !fileOpen && 'hidden')}>
        <div className="flex min-h-10 min-w-0 items-center gap-2 border-b border-line px-2">
          <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label="返回包文件" title="返回包文件" className="shrink-0 md:hidden">
            <ArrowLeft />
          </Button>
          <h2 className="min-w-0 flex-1 truncate font-mono text-xs" title={selected}>{selected}</h2>
          {selected !== 'FLOW.md' && Object.hasOwn(files, selected) && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`删除 ${selected}`}
              title="删除文件"
              onClick={() => onRemove(selected)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
        {selected.endsWith('.md') ? (
          <MarkdownEditor
            key={selected}
            className="rounded-none border-0"
            path={selected}
            value={files[selected] ?? ''}
            onChange={(text) => onChange(selected, text)}
            onOpenFile={open}
          />
        ) : (
          <Textarea
            className="min-h-[30rem] resize-y rounded-none border-0 font-mono text-xs leading-5"
            aria-label={`${selected} 内容`}
            spellCheck={false}
            value={files[selected] ?? ''}
            onChange={(event) => onChange(selected, event.target.value)}
          />
        )}
      </section>
    </div>
  )
}
