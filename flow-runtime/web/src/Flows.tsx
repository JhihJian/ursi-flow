import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FilePlus2,
  FileText,
  Network,
  Play,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Workflow,
} from 'lucide-react'
import { AsyncState, PageHeading, Refresh, message, useLoad } from './main'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert'
import { Badge } from './components/ui/badge'
import { Button, buttonVariants } from './components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { Empty, EmptyContent, EmptyMedia, EmptyTitle } from './components/ui/empty'
import { Input } from './components/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from './components/ui/item'
import { Label } from './components/ui/label'
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs'
import { Textarea } from './components/ui/textarea'
import { FlowCanvas } from './Graph'
import { Markdown, MarkdownEditor } from './Markdown'
import { StartRunDialog } from './StartRunDialog'
import { cn } from './lib/utils'
import { providerMissing, type FlowFiles, type Source } from './data'
import {
  frontmatterMeta,
  frontmatterOf,
  joinSections,
  parseFlow,
  serializeFlow,
  splitSections,
  syncSections,
} from './flow/doc'
import { graphIssues, type ActionKind, type FlowGraph } from './flow/graph'
import { setActionKind } from './flow/edit'

const idPattern = /^[A-Za-z0-9][\w-]{0,95}$/
const filePattern = /^(FLOW\.md|(references|scripts)\/(?:[^/\\]+\/)*[^/\\]+)$/
const template = `---
name: 新流程
description: 说明这个流程适用于什么任务。
variables:
  任务:
    description: 本次任务说明
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> work[执行任务]
  work -->|已完成| finish((结束))
\`\`\`

## 执行任务

\`\`\`新建Agent
执行以下任务：
{var.任务}
\`\`\`

### 已完成

任务已完成。
`
const blankFiles = (): FlowFiles => ({ 'FLOW.md': template })

interface FlowEntry {
  id: string
  revision?: string
  name?: string
  description?: string
  nodes?: number
  files?: number
  error?: string
}

/** 列表需要名称、说明与规模：逐个读包，单个失败不影响其余行。 */
async function listFlows(source: Source, signal: AbortSignal): Promise<FlowEntry[]> {
  const ids = await source.flows(signal)
  return Promise.all(
    ids.map(async (id): Promise<FlowEntry> => {
      try {
        const pkg = await source.flow(id, signal)
        const text = pkg.files['FLOW.md'] ?? ''
        // 元信息与图分别解析：图坏了也要能列出名称与说明。
        const meta = { ...frontmatterMeta(frontmatterOf(text)) }
        let nodes: number | undefined
        try {
          nodes = parseFlow(text).graph.nodes.length
        } catch {
          nodes = undefined
        }
        return {
          id,
          revision: pkg.revision,
          ...meta,
          nodes,
          files: Object.keys(pkg.files).length,
        }
      } catch (cause) {
        return { id, error: message(cause) }
      }
    }),
  )
}

export function Flows({ source }: { source: Source }) {
  const state = useLoad((signal) => listFlows(source, signal), [source])
  const [query, setQuery] = useState('')
  const rows = state.value || []
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? rows.filter((row) =>
        [row.id, row.name, row.description].some((value) => value?.toLowerCase().includes(needle)),
      )
    : rows
  return (
    <main>
      <PageHeading
        title="Flow 包"
        description="已发布的流程目录，新运行使用当前修订"
        actions={
          <>
            <Refresh state={state} />
            <Button variant="primary" asChild>
              <Link to="/flows/new">
                <FilePlus2 />
                创建 Flow
              </Link>
            </Button>
          </>
        }
      />
      {!state.value ? (
        <AsyncState state={state} />
      ) : !rows.length ? (
        <Empty role="status">
          <EmptyMedia>
            <Workflow />
          </EmptyMedia>
          <EmptyTitle>暂无 Flow 包</EmptyTitle>
          <EmptyContent>
            <Button asChild>
              <Link to="/flows/new">创建第一个 Flow</Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="按名称或说明筛选"
                aria-label="筛选 Flow 包"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {needle ? `${shown.length} / ${rows.length} 个包` : `共 ${rows.length} 个包`}
            </p>
          </div>
          {!shown.length ? (
            <Empty>
              <EmptyMedia>
                <Search />
              </EmptyMedia>
              <EmptyTitle>没有匹配的 Flow 包</EmptyTitle>
              <EmptyContent>
                <Button variant="ghost" size="sm" onClick={() => setQuery('')}>
                  清除筛选
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ItemGroup>
              {shown.map((row) => (
                <Item key={row.id} asChild>
                  <Link to={`/flows/${encodeURIComponent(row.id)}/edit`}>
                    <ItemMedia>
                      <Workflow />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="truncate">{row.name || row.id}</span>
                        <code className="truncate font-mono text-[11px] font-normal text-muted-foreground">
                          {row.id}
                        </code>
                      </ItemTitle>
                      <ItemDescription>
                        {row.error ? (
                          <span className="text-warn">无法读取包内容：{row.error}</span>
                        ) : (
                          row.description || '这个包还没有写说明'
                        )}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="gap-2">
                      {row.error ? (
                        <Badge variant="warn">不可用</Badge>
                      ) : (
                        <>
                          {typeof row.nodes === 'number' && (
                            <Badge variant="outline">{row.nodes} 个节点</Badge>
                          )}
                          {row.revision && (
                            <Badge variant="default" className="hidden font-mono sm:inline-flex">
                              {row.revision.slice(0, 8)}
                            </Badge>
                          )}
                          <ChevronRight className="size-4 text-muted-foreground" />
                        </>
                      )}
                    </ItemActions>
                  </Link>
                </Item>
              ))}
            </ItemGroup>
          )}
        </div>
      )}
    </main>
  )
}

// 图形与文档是两种编辑方式；scripts 下的脚本只能按代码编辑。
type View = 'graph' | 'doc' | 'code'

export function FlowEditor({ source }: { source: Source }) {
  const id = useParams<'id'>().id
  const editing = Boolean(id)
  const navigate = useNavigate()
  const loaded = useLoad(
    async (signal) => (id ? await source.flow(id, signal) : null),
    [source, id],
  )
  const [name, setName] = useState(id || '')
  const [files, setFiles] = useState<FlowFiles>(() => (editing ? {} : blankFiles()))
  const [revision, setRevision] = useState('')
  const [selected, setSelected] = useState('FLOW.md')
  const [view, setView] = useState<View>('graph')
  const [dirty, setDirty] = useState(!editing)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [newPath, setNewPath] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  // provider 没配全时不让启动，避免用户提交后才看到失败。
  const config = useLoad(async (signal) => source.config(signal), [source])
  const missingProvider = providerMissing(config.value)
  // 修订号是整个目录共用的，必须连同 Flow 标识一起比较，否则切换包时不会刷新。
  const loadedKey = useRef<string | null>(null)

  useEffect(() => {
    const pkg = loaded.value
    const key = pkg ? `${pkg.id}:${pkg.revision}` : ''
    if (!pkg || loadedKey.current === key) return
    loadedKey.current = key
    setName(pkg.id)
    setFiles(pkg.files)
    setRevision(pkg.revision)
    setDirty(false)
    setSelected(pkg.files['FLOW.md'] !== undefined ? 'FLOW.md' : Object.keys(pkg.files)[0])
  }, [loaded.value])

  const flowText = files['FLOW.md'] ?? ''
  const parsed = useMemo(() => {
    try {
      return { doc: parseFlow(flowText), error: '' }
    } catch (cause) {
      return { doc: null, error: cause instanceof Error ? cause.message : 'FLOW.md 无法解析' }
    }
  }, [flowText])
  const parsedSections = useMemo(
    () => (parsed.doc ? splitSections(parsed.doc.post).sections : []),
    [parsed.doc],
  )
  const issues = useMemo(
    () => (parsed.doc ? graphIssues(parsed.doc.graph) : []),
    [parsed.doc],
  )

  /** 选中文件后切到能编辑它的视图：FLOW.md 用图形，Markdown 用文档，脚本用代码。 */
  const openFile = (path: string) => {
    setSelected(path)
    setView(path === 'FLOW.md' ? (parsed.doc ? 'graph' : 'doc') : path.endsWith('.md') ? 'doc' : 'code')
  }

  if (editing && !loaded.value) {
    return (
      <main>
        <Link className="back" to="/flows">
          返回 Flow 包
        </Link>
        <AsyncState state={loaded} />
      </main>
    )
  }

  const writeFile = (path: string, text: string) => {
    setFiles((current) => ({ ...current, [path]: text }))
    setDirty(true)
    setNotice('')
  }
  /** 用新图结构重写 FLOW.md，节点小节正文保持不变。 */
  const applyGraph = (next: FlowGraph) => {
    if (!parsed.doc) return
    const { prologue, sections } = splitSections(parsed.doc.post)
    const synced = syncSections(sections, parsed.doc.graph, next)
    writeFile(
      'FLOW.md',
      serializeFlow({ ...parsed.doc, graph: next, post: joinSections(prologue, synced) }),
    )
  }
  /** 改单个节点的动作类型或正文。 */
  const applyAction = (ref: string, change: { kind?: ActionKind; body?: string }) => {
    if (!parsed.doc) return
    const node = parsed.doc.graph.nodes.find((item) => item.ref === ref)
    if (!node) return
    if (change.kind) {
      // 类型变化会牵动出边规则，交给图重写统一处理，小节随图同步。
      applyGraph(setActionKind(parsed.doc.graph, ref, change.kind))
      return
    }
    const { prologue, sections } = splitSections(parsed.doc.post)
    const next = sections.map((section) => {
      if (section.name !== node.name) return section
      const action = section.body.match(/```(新建Agent|复用Agent|执行自定义命令|执行Flow)[ \t]*\n([\s\S]*?)```/)
      if (!action || change.body === undefined) return section
      const body = section.body.replace(
        action[0],
        '```' + action[1] + '\n' + change.body.replace(/\s+$/, '') + '\n```',
      )
      return { ...section, body }
    })
    writeFile('FLOW.md', serializeFlow({ ...parsed.doc, post: joinSections(prologue, next) }))
  }

  const removeFile = (path: string) => {
    if (path === 'FLOW.md') return
    setFiles((current) => {
      const next = { ...current }
      delete next[path]
      return next
    })
    if (selected === path) setSelected('FLOW.md')
    setDirty(true)
  }
  const addFile = () => {
    const path = newPath.trim()
    if (!filePattern.test(path) || path.split('/').some((part) => part === '.' || part === '..'))
      return setError('文件路径只能是 FLOW.md、references/ 或 scripts/ 下的文件')
    if (files[path] !== undefined) return setError('文件已存在')
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1))
      if (files[path.slice(0, i)] !== undefined) return setError('文件与目录重名')
    setError('')
    writeFile(path, path.endsWith('.md') ? `# ${path.split('/').pop()?.replace(/\.md$/, '')}\n` : '')
    setSelected(path)
    setView(path.endsWith('.md') ? 'doc' : 'code')
    setNewPath('')
  }
  const run = async (action: 'validate' | 'save' | 'delete') => {
    setBusy(action)
    setError('')
    setNotice('')
    try {
      if (action === 'validate') {
        if (!idPattern.test(name)) throw new Error('Flow 标识只能包含字母、数字、下划线和连字符')
        const result = await source.validate(name, files)
        setNotice(`校验通过：${result.id}${issues.length ? `（图结构仍有 ${issues.length} 处提示）` : ''}`)
      } else if (action === 'save') {
        if (!editing && !idPattern.test(name))
          throw new Error('Flow 标识只能包含字母、数字、下划线和连字符')
        const result = editing
          ? await source.update(name, files, revision || undefined)
          : await source.create(name, files)
        setRevision(result.revision)
        setDirty(false)
        setNotice(`已保存修订 ${result.revision.slice(0, 8)}`)
        if (!editing) navigate(`/flows/${encodeURIComponent(result.id)}/edit`, { replace: true })
      } else {
        await source.remove(name)
        navigate('/flows', { replace: true })
      }
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy('')
    }
  }
  // 启动参数由对话框按 FLOW.md 的全局变量声明生成，这里只负责提交与跳转。
  const start = async (parsedVariables: Record<string, unknown>, runId: string) => {
    // 失败时对话框留在原地显示原因，成功后跳转详情页。
    const created = await source.start(name, parsedVariables, runId || undefined)
    navigate(`/runs/${encodeURIComponent(created.id)}`)
  }
  const readOnly = source.mode === 'demo'
  const isMarkdown = selected.endsWith('.md')
  const paths = Object.keys(files).sort((a, b) =>
    a === 'FLOW.md' ? -1 : b === 'FLOW.md' ? 1 : a.localeCompare(b),
  )
  return (
    <main className="editor-page">
      <Link className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 mb-2')} to="/flows">
        <ArrowLeft />
        返回 Flow 包
      </Link>
      <PageHeading
        title={editing ? name : '创建 Flow'}
        description={`${editing ? `当前修订 ${revision ? revision.slice(0, 8) : '未知'}` : '即时校验包文件，创建后进入编辑'}${dirty ? ' · 有未保存修改' : ''}`}
        actions={
          <>
            <Button onClick={() => run('validate')} disabled={readOnly || Boolean(busy)}>
              <ShieldCheck />
              校验
            </Button>
            {editing && (
              <Button
                onClick={loaded.refresh}
                disabled={Boolean(busy) || loaded.loading}
                title="丢弃未保存修改，读取已发布修订"
              >
                <RotateCcw />
                重新载入
              </Button>
            )}
            <Button variant="primary" onClick={() => run('save')} disabled={readOnly || Boolean(busy) || !dirty}>
              <Save />
              保存
            </Button>
            {editing && (
              <Button variant="destructive" onClick={() => setConfirm(true)} disabled={readOnly || Boolean(busy)}>
                <Trash2 />
                删除
              </Button>
            )}
          </>
        }
      />
      {error && (
        <Alert variant="error">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert variant="success">
          <AlertDescription role="status">{notice}</AlertDescription>
        </Alert>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {name}</DialogTitle>
            <DialogDescription>
              删除会移除当前修订中的整个包目录，已启动的运行仍可读取历史。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => run('delete')}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="mt-4">
        <CardContent className="flex flex-col gap-3 pt-4 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="flow-name">Flow 标识</Label>
            <Input
              id="flow-name"
              className="h-8 w-44 font-mono text-xs"
              value={name}
              readOnly={editing}
              onChange={(event) => {
                setName(event.target.value)
                setDirty(true)
              }}
              placeholder="release-check"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileCode2 />
              包文件
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {paths.map((path) => (
                <span key={path} className="flex min-w-0 items-center gap-0.5">
                  <Button
                    size="sm"
                    variant={selected === path ? 'secondary' : 'ghost'}
                    aria-pressed={selected === path}
                    onClick={() => openFile(path)}
                    className={cn(
                      'min-w-0 max-w-[11rem] px-2 font-mono text-[11px] sm:max-w-[13rem]',
                      selected === path && 'bg-accent-dim text-accent-2',
                    )}
                  >
                    <span className="truncate">{path}</span>
                  </Button>
                  {path !== 'FLOW.md' && selected === path && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`删除 ${path}`}
                      onClick={() => removeFile(path)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </span>
              ))}
            </div>
            <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
              <Input
                aria-label="新增文件路径"
                className="h-7 min-w-0 flex-1 px-2 text-[11px] sm:w-44 sm:flex-none"
                placeholder="references/checklist.md"
                value={newPath}
                onChange={(event) => setNewPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addFile()
                  }
                }}
              />
              <Button size="icon-sm" variant="ghost" onClick={addFile} aria-label="新增文件" title="新增文件">
                <FilePlus2 />
              </Button>
            </div>
          </div>
          {editing && (
            <Button
              variant="primary"
              className="sm:ml-auto"
              onClick={() => setStartOpen(true)}
              disabled={readOnly || dirty || busy === 'save' || missingProvider.length > 0}
              title={
                dirty
                  ? '请先保存包文件'
                  : missingProvider.length
                    ? `模型 provider 未配置：缺 ${missingProvider.join('、')}`
                    : undefined
              }
            >
              <Play />
              启动运行
            </Button>
          )}
        </CardContent>
      </Card>
      {readOnly && (
        <p className="mt-2 text-xs text-muted-foreground">演示数据不连接 Runtime，保存、校验与启动都不可用。</p>
      )}
      {!readOnly && missingProvider.length > 0 && (
        <Alert variant="warning" className="mt-3">
          <CircleAlert />
          <AlertDescription>
            模型 provider 还没配全（缺 {missingProvider.join('、')}），Agent 节点无法执行。
            <Link
              className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'ml-1 h-auto p-0')}
              to="/flow-config"
            >
              去运行配置
            </Link>
          </AlertDescription>
        </Alert>
      )}
      <StartRunDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        flowId={name}
        markdown={flowText}
        onStart={start}
      />

      <section className="mt-3 min-w-0">
        <Tabs value={view} onValueChange={(next) => setView(next as View)}>
          <TabsList>
            {selected === 'FLOW.md' && (
              <TabsTrigger value="graph" disabled={!parsed.doc}>
                <Network />
                图形
              </TabsTrigger>
            )}
            {isMarkdown && (
              <TabsTrigger value="doc">
                <FileText />
                文档
              </TabsTrigger>
            )}
            {!isMarkdown && (
              <TabsTrigger value="code">
                <FileCode2 />
                脚本
              </TabsTrigger>
            )}
            <span className="ml-auto flex items-center gap-2">
              <span className="truncate font-mono text-xs text-muted-foreground">{selected}</span>
              {issues.length > 0 && <Badge variant="warn">{issues.length} 处结构提示</Badge>}
            </span>
          </TabsList>

          {view === 'graph' && parsed.doc && (
            <>
              {issues.length > 0 && (
                <Alert variant="warning" role="status">
                  <AlertTitle>{issues.length} 处结构提示</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              <FlowCanvas
                graph={parsed.doc.graph}
                sections={parsedSections}
                issues={issues}
                onGraph={applyGraph}
                onAction={applyAction}
                onStart={() => setStartOpen(true)}
              />
            </>
          )}
          {view === 'graph' && !parsed.doc && (
            <Alert variant="warning" className="mt-3">
              <CircleAlert />
              <AlertDescription>{parsed.error}。切到文档视图即可直接修改 FLOW.md 原文。</AlertDescription>
            </Alert>
          )}
          {view === 'doc' &&
            (isMarkdown ? (
              <MarkdownEditor
                value={files[selected] ?? ''}
                path={selected}
                onChange={(next) => writeFile(selected, next)}
                onOpenFile={(path) => {
                  if (files[path] !== undefined) openFile(path)
                  else setError(`包内没有 ${path}`)
                }}
              />
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">只有 Markdown 文件提供文档视图。</p>
            ))}
          {view === 'code' && !isMarkdown && (
            <Textarea
              className="mt-3 min-h-[26rem] font-mono text-xs leading-5"
              aria-label={`${selected} 内容`}
              spellCheck={false}
              value={files[selected] ?? ''}
              onChange={(event) => writeFile(selected, event.target.value)}
            />
          )}
        </Tabs>
      </section>
    </main>
  )
}
