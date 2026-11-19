import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  FilePlus2,
  FileText,
  FolderTree,
  Network,
  Play,
  RotateCcw,
  Save,
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
import { DataTable, dataTableFeatures, type DataTableColumn } from './components/ui/data-table'
import { Empty, EmptyContent, EmptyMedia, EmptyTitle } from './components/ui/empty'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs'
import { FlowCanvas } from './Graph'
import { FlowOverview } from './FlowOverview'
import { MarkdownEditor } from './Markdown'
import { StartRunDialog } from './StartRunDialog'
import { cn } from './lib/utils'
import { createColumnHelper } from '@tanstack/react-table'
import { providerMissing, type FlowFiles, type FlowSummary, type Source } from './data'
import {
  joinSections,
  parseFlow,
  serializeFlow,
  splitSections,
  syncSections,
} from './flow/doc'
import { graphIssues, type ActionKind, type FlowGraph } from './flow/graph'
import { setActionKind } from './flow/edit'

const idPattern = /^[A-Za-z0-9][\w-]{0,95}$/
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

/** 列表行：名称、说明与规模来自 daemon 的摘要接口，一次请求读完整个目录。 */
export function Flows({ source }: { source: Source }) {
  const state = useLoad((signal) => source.flowSummaries(signal), [source])
  const rows = state.value || []
  const [removing, setRemoving] = useState<FlowSummary | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const readOnly = source.mode === 'demo'

  const columns = useMemo<DataTableColumn<FlowSummary>[]>(() => {
    const helper = createColumnHelper<typeof dataTableFeatures, FlowSummary>()
    return helper.columns([
      // 筛选按显示名、标识与说明匹配，与输入框提示一致。
      helper.accessor((row) => `${row.name ?? ''} ${row.id}`, {
        id: 'name',
        header: '名称',
        sortFn: 'text',
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link
              className="truncate font-medium text-foreground hover:underline"
              to={`/flows/${encodeURIComponent(row.original.id)}/edit`}
            >
              {row.original.name || row.original.id}
            </Link>
            <code className="truncate font-mono text-[11px] text-muted-foreground">
              {row.original.id}
            </code>
          </div>
        ),
      }),
      helper.accessor((row) => row.description ?? '', {
        id: 'description',
        header: '说明',
        meta: { className: 'hidden lg:table-cell', cellClassName: 'hidden lg:table-cell' },
        enableSorting: false,
        cell: ({ row }) =>
          row.original.error ? (
            <span className="line-clamp-2 text-xs text-warn">无法解析：{row.original.error}</span>
          ) : (
            <span className="line-clamp-2 text-xs text-muted-foreground">
              {row.original.description || '还没有写说明'}
            </span>
          ),
      }),
      helper.accessor((row) => row.nodes ?? -1, {
        id: 'nodes',
        header: '节点',
        sortFn: 'alphanumeric',
        cell: ({ row }) =>
          row.original.error ? (
            <Badge variant="warn">不可用</Badge>
          ) : (
            <span className="tabular-nums">{row.original.nodes ?? '·'}</span>
          ),
      }),
      helper.accessor((row) => row.variables ?? 0, {
        id: 'variables',
        header: '启动变量',
        meta: { className: 'hidden sm:table-cell', cellClassName: 'hidden sm:table-cell' },
        sortFn: 'alphanumeric',
        cell: ({ row }) => <span className="tabular-nums">{row.original.variables ?? 0}</span>,
      }),
      helper.accessor((row) => row.revision ?? '', {
        id: 'revision',
        header: '修订',
        meta: { className: 'hidden sm:table-cell', cellClassName: 'hidden sm:table-cell' },
        sortFn: 'text',
        cell: ({ row }) => (
          <code className="font-mono text-[11px] text-muted-foreground">
            {row.original.revision ? row.original.revision.slice(0, 8) : '·'}
          </code>
        ),
      }),
      helper.display({
        id: 'actions',
        header: () => <span className="sr-only">操作</span>,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" asChild>
              <Link to={`/flows/${encodeURIComponent(row.original.id)}/edit`}>
                编辑
                <ChevronRight />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`删除 ${row.original.id}`}
              title={readOnly ? '演示数据不能删除' : '删除'}
              disabled={readOnly}
              onClick={() => {
                setError('')
                setRemoving(row.original)
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ),
      }),
    ])
  }, [readOnly])

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    setError('')
    try {
      await source.remove(removing.id)
      setRemoving(null)
      setResetKey((count) => count + 1)
      state.refresh()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <PageHeading
        title="Flow 包"
        description={`${rows.length} 个包 · 新运行使用当前修订`}
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
        <DataTable
          columns={columns}
          data={rows}
          filterPlaceholder="按名称、说明或标识筛选"
          countLabel="个包"
          emptyTitle="暂无 Flow 包"
          filterResetKey={resetKey}
        />
      )}
      <Dialog open={Boolean(removing)} onOpenChange={(next) => !next && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {removing?.name || removing?.id}</DialogTitle>
            <DialogDescription>
              删除会从当前修订移除整个包目录，已启动的运行仍可读取历史。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="error">
              <AlertDescription role="alert">{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">取消</Button>
            </DialogClose>
            <Button variant="destructive" onClick={remove} disabled={busy}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

type View = 'overview' | 'graph' | 'doc'

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
  const [fileOpen, setFileOpen] = useState(false)
  const [view, setView] = useState<View>('overview')
  const [dirty, setDirty] = useState(!editing)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  // provider 没配全时不让启动，避免用户提交后才看到失败。
  const config = useLoad(async (signal) => source.config(signal), [source])
  const missingProvider = providerMissing(config.value)
  // 修订号是整个目录共用的，必须连同 Flow 标识一起比较，否则切换包时不会刷新。
  const loadedPackage = useRef<{ id: string; revision: string } | null>(null)

  useEffect(() => {
    const pkg = loaded.value
    if (!pkg) return
    const previous = loadedPackage.current
    if (previous?.id === pkg.id && previous.revision === pkg.revision) return
    loadedPackage.current = { id: pkg.id, revision: pkg.revision }
    setName(pkg.id)
    setFiles(pkg.files)
    setRevision(pkg.revision)
    setDirty(false)
    if (previous?.id !== pkg.id) {
      setSelected('FLOW.md')
      setFileOpen(false)
      setView('overview')
    } else {
      setSelected((path) => Object.hasOwn(pkg.files, path) ? path : 'FLOW.md')
    }
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

  const openFile = (path: string) => {
    if (!Object.hasOwn(files, path)) {
      setError(`包内没有 ${path}`)
      return false
    }
    setSelected(path)
    setFileOpen(true)
    setError('')
    return true
  }

  if (editing && loaded.value?.id !== id) {
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
    setFileOpen(false)
    setDirty(true)
    setNotice('')
  }
  const addFile = (input: string) => {
    const path = input.trim()
    if (/^[A-Za-z]:|[\\\0]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      setError('请输入有效的包内相对文件路径')
      return
    }
    if (Object.hasOwn(files, path)) {
      setError('文件已存在')
      return
    }
    if (Object.keys(files).some((file) => file.startsWith(`${path}/`) || path.startsWith(`${file}/`))) {
      setError('文件与目录重名')
      return
    }
    setError('')
    writeFile(path, path.endsWith('.md') ? `# ${path.split('/').pop()?.replace(/\.md$/, '')}\n` : '')
    setSelected(path)
    setFileOpen(true)
    return path
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
  const start = async (
    parsedVariables: Record<string, unknown>,
    runId: string,
    cwd: string,
  ) => {
    // 失败时对话框留在原地显示原因，成功后跳转详情页。cwd 留空由 Runtime 在工作区下新建。
    const created = await source.start(
      name,
      parsedVariables,
      runId || undefined,
      cwd || undefined,
    )
    navigate(`/runs/${encodeURIComponent(created.id)}`)
  }
  const readOnly = source.mode === 'demo'
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
        workspace={config.value?.workspace}
        onStart={start}
      />

      <section className="mt-3 min-w-0">
        <Tabs value={view} onValueChange={(next) => setView(next as View)}>
          <TabsList aria-label="Flow 编辑视图">
            <TabsTrigger value="overview">
              <FolderTree />
              总览
            </TabsTrigger>
            <TabsTrigger value="graph">
              <Network />
              图形
            </TabsTrigger>
            <TabsTrigger value="doc">
              <FileText />
              文档
            </TabsTrigger>
            {issues.length > 0 && <Badge variant="warn" className="ml-auto">{issues.length} 处结构提示</Badge>}
          </TabsList>

          <TabsContent value="overview" className="mt-3">
            <FlowOverview
              key={id}
              files={files}
              selected={selected}
              fileOpen={fileOpen}
              onBack={() => setFileOpen(false)}
              onOpen={openFile}
              onAdd={addFile}
              onRemove={removeFile}
              onChange={writeFile}
            />
          </TabsContent>
          <TabsContent value="graph" className="mt-3">
            {parsed.doc ? (
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
            ) : (
              <Alert variant="warning" role="status">
                <CircleAlert />
                <AlertDescription>{parsed.error}。切到文档视图即可直接修改 FLOW.md 原文。</AlertDescription>
              </Alert>
            )}
          </TabsContent>
          <TabsContent value="doc" className="mt-3">
            <MarkdownEditor
              value={flowText}
              path="FLOW.md"
              onChange={(next) => writeFile('FLOW.md', next)}
              onOpenFile={(path) => {
                if (openFile(path)) setView('overview')
              }}
            />
          </TabsContent>
        </Tabs>
      </section>
    </main>
  )
}
