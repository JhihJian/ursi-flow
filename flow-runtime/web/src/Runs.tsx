import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import {
  ArrowLeft,
  ChevronRight,
  CircleStop,
  History,
  ListOrdered,
  Network,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react'
import {
  AsyncState,
  PageHeading,
  Refresh,
  Status,
  message,
  statusLabel,
  useLoad,
  type Loaded,
} from './main'
import { Alert, AlertDescription } from './components/ui/alert'
import { Badge } from './components/ui/badge'
import { DataTable, dataTableFeatures, type DataTableColumn } from './components/ui/data-table'
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
  ItemGroup,
  ItemMedia,
} from './components/ui/item'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs'
import { createColumnHelper } from '@tanstack/react-table'
import type { FlowPackage, NodeRun, Run, RunHistory, Source } from './data'
import { actionOf, parseFlow, splitSections } from './flow/doc'
import type { ActionKind, FlowGraph } from './flow/graph'
import {
  clock,
  decisionSummary,
  enteredFromLabel,
  finishSummary,
  routeRecords,
} from './flow/route-records'
import { runFlowState } from './flow/run-state'
import { RunGraph } from './RunGraph'
import { cn } from './lib/utils'

const RunTrajectory = lazy(() => import('./RunTrajectory'))

const when = (value?: string) => {
  if (!value) return '·'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false })
}
const duration = (start: string, end?: string) => {
  if (!end) return '·'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '·'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
const nodeLabel = (run: NodeRun) => `${run.nodeName || run.nodeRef}`
const refName = (history: RunHistory, nodeRunId: string) => {
  const found = history.nodeRuns.find((run) => run.id === nodeRunId)
  return found ? nodeLabel(found) : nodeRunId
}
const json = (value: unknown) => JSON.stringify(value ?? null, null, 2)
const isAgent = (node: NodeRun) => node.actionKind === '新建Agent' || node.actionKind === '复用Agent'

export function Runs({ source }: { source: Source }) {
  const state = useLoad((signal) => source.runs(signal), [source])
  const rows = state.value || []
  const running = rows.filter((row) => row.status === 'running').length
  const columns = useMemo<DataTableColumn<Run>[]>(() => {
    const helper = createColumnHelper<typeof dataTableFeatures, Run>()
    return helper.columns([
      helper.accessor((row) => row.id, {
        id: 'id',
        header: 'Run',
        sortFn: 'text',
        cell: ({ row }) => (
          <Link
            className="block max-w-32 truncate font-mono text-[11px] font-medium text-foreground hover:underline sm:max-w-56 sm:text-[12px]"
            title={row.original.id}
            to={`/runs/${encodeURIComponent(row.original.id)}`}
          >
            {row.original.id}
          </Link>
        ),
      }),
      helper.accessor((row) => row.flow, {
        id: 'flow',
        header: 'Flow',
        meta: { className: 'hidden sm:table-cell', cellClassName: 'hidden sm:table-cell' },
        sortFn: 'text',
        cell: ({ row }) => (
          <Link
            className="whitespace-nowrap hover:underline"
            to={`/flows/${encodeURIComponent(row.original.flow)}/edit`}
          >
            {row.original.flow}
          </Link>
        ),
      }),
      helper.accessor((row) => statusLabel(row.status), {
        id: 'status',
        header: '状态',
        sortFn: 'text',
        cell: ({ row }) => <Status status={row.original.status} />,
      }),
      helper.accessor((row) => row.revision, {
        id: 'revision',
        header: '修订',
        meta: { className: 'hidden sm:table-cell', cellClassName: 'hidden sm:table-cell' },
        sortFn: 'text',
        cell: ({ row }) => (
          <code className="font-mono text-[11px] text-muted-foreground">
            {row.original.revision.slice(0, 8)}
          </code>
        ),
      }),
      helper.accessor((row) => row.cwd, {
        id: 'cwd',
        header: '工作目录',
        meta: { className: 'hidden lg:table-cell', cellClassName: 'hidden lg:table-cell' },
        sortFn: 'text',
        cell: ({ row }) => (
          <span
            className="block max-w-72 truncate font-mono text-[11px] text-muted-foreground"
            title={row.original.cwd}
          >
            {row.original.cwd}
          </span>
        ),
      }),
      helper.display({
        id: 'actions',
        header: () => <span className="sr-only">操作</span>,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="icon-sm" asChild>
              <Link
                to={`/runs/${encodeURIComponent(row.original.id)}`}
                aria-label={`查看运行 ${row.original.id}`}
              >
                <ChevronRight />
              </Link>
            </Button>
          </div>
        ),
      }),
    ])
  }, [])
  return (
    <main>
      <PageHeading
        title="运行记录"
        description={`${rows.length} 条记录${running > 0 ? ` · ${running} 条运行中` : ''}`}
        actions={<Refresh state={state} />}
      />
      {!state.value ? (
        <AsyncState state={state} />
      ) : !rows.length ? (
        <Empty role="status">
          <EmptyMedia>
            <History />
          </EmptyMedia>
          <EmptyTitle>暂无运行记录</EmptyTitle>
          <EmptyContent>
            <Button asChild>
              <Link to="/flows">从 Flow 包发起运行</Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          filterPlaceholder="按 Run、Flow、状态或目录筛选"
          countLabel="条记录"
          emptyTitle="暂无运行记录"
        />
      )}
    </main>
  )
}

// facts.json 在运行尚未提交任何事实时可能缺少集合字段，界面按空集合处理。
function normalize(history: RunHistory): RunHistory {
  return {
    ...history,
    runs: history.runs ?? [],
    nodeRuns: history.nodeRuns ?? [],
    routeDecisions: history.routeDecisions ?? [],
    parallelRounds: history.parallelRounds ?? [],
    recoveries: history.recoveries ?? [],
  }
}

/** 详情页的区块标题：标题与说明放在内容上方，内容自己带边框，避免卡片套卡片。 */
function Panel({
  title,
  meta,
  children,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-muted-foreground">
          {title}
        </h2>
        {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
      </div>
      {children}
    </section>
  )
}

const mono = 'rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-txt2'

/** 运行详情：流转图与节点执行记录两类视图共用同一份事实。 */
export function RunDetail({ source }: { source: Source }) {
  const id = useParams<'id'>().id!
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'nodes' ? 'nodes' : 'flow'
  const selectedId = params.get('node') || ''
  const job = useLoad((signal) => source.run(id, signal), [source, id])
  const history = useLoad((signal) => source.history(id, signal), [source, id])
  const flow = useLoad((signal) => source.runFlow(id, signal), [source, id])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [paramsOpen, setParamsOpen] = useState(false)
  const { refresh: reloadJob } = job
  const { refresh: reloadHistory } = history
  const { refresh: reloadFlow } = flow
  const refreshAll = () => {
    reloadJob()
    reloadHistory()
    reloadFlow()
  }
  useEffect(() => {
    if (job.value?.status !== 'running' || busy) return
    const timer = setTimeout(() => {
      reloadJob()
      reloadHistory()
    }, 3000)
    return () => clearTimeout(timer)
  }, [job.value, busy, reloadJob, reloadHistory])

  const stop = async () => {
    setBusy(true)
    setError('')
    setConfirm(false)
    try {
      await source.stop(id)
      reloadJob()
      reloadHistory()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const facts = history.value ? normalize(history.value) : undefined
  const run = facts?.runs.find((item) => item.id === id)
  const children = (facts?.runs || []).filter((item) => item.id !== id)
  const jobRow = job.value

  const graph = useMemo(() => {
    const text = flow.value?.files['FLOW.md']
    if (!text) return null
    try {
      const doc = parseFlow(text)
      const { sections } = splitSections(doc.post)
      const kinds: Record<string, ActionKind | undefined> = {}
      for (const node of doc.graph.nodes) {
        const section = sections.find((item) => item.name === node.name)
        kinds[node.ref] = section ? actionOf(section)?.kind : undefined
      }
      return { graph: doc.graph, kinds }
    } catch {
      return null
    }
  }, [flow.value])

  const state = useMemo(
    () => (graph && facts ? runFlowState(graph.graph, run, facts) : undefined),
    [graph, facts, run],
  )

  // 未指定节点时跟到当前节点或最近一次访问，刷新页面仍停在同一条记录。
  const selected = useMemo(() => {
    if (!facts?.nodeRuns.length) return undefined
    const found = facts.nodeRuns.find((node) => node.id === selectedId)
    if (found) return found
    const current = run?.currentNodeRunId as string | undefined
    return (
      facts.nodeRuns.find((node) => node.id === current) ??
      [...facts.nodeRuns].sort((left, right) => right.sequence - left.sequence)[0]
    )
  }, [facts, run, selectedId])

  const update = (next: { tab?: 'flow' | 'nodes'; node?: string }) => {
    const search = new URLSearchParams()
    const target = next.tab ?? (tab === 'nodes' ? 'nodes' : 'flow')
    if (target === 'nodes') search.set('tab', 'nodes')
    const node = next.node ?? (target === 'nodes' ? selected?.id : undefined)
    if (node) search.set('node', node)
    setParams(search, { replace: true })
  }
  // 从图上点进节点：取该引用最近一次访问，回边场景下也落到刚跑过的那次。
  const openNode = (ref: string) => {
    const visits = (facts?.nodeRuns ?? []).filter((node) => node.nodeRef === ref)
    const latest = visits.sort((left, right) => right.sequence - left.sequence)[0]
    if (latest) update({ tab: 'nodes', node: latest.id })
  }

  const startedAt = (run?.startedAt as string) || undefined
  const completedAt = (run?.completedAt as string) || undefined

  return (
    <main className="space-y-4">
      <Link className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 w-fit')} to="/runs">
        <ArrowLeft />
        运行记录
      </Link>
      {!jobRow ? (
        <AsyncState state={job} />
      ) : (
        <>
          <Card>
            <CardHeader className="gap-3">
              <div className="min-w-0 space-y-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h1 className="break-all font-mono text-lg font-semibold">{jobRow.id}</h1>
                  <Status status={jobRow.status} />
                  {run?.phase && run.phase !== jobRow.status && (
                    <Badge variant="outline">{run.phase}</Badge>
                  )}
                </div>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Flow{' '}
                    <Link
                      className="text-foreground hover:underline"
                      to={`/flows/${encodeURIComponent(jobRow.flow)}/edit`}
                    >
                      {jobRow.flow}
                    </Link>
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    修订 <code className={mono}>{jobRow.revision.slice(0, 8)}</code>
                  </span>
                  <span aria-hidden>·</span>
                  <span>开始 {when(startedAt)}</span>
                  <span aria-hidden>·</span>
                  <span>耗时 {duration(startedAt ?? '', completedAt)}</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => setParamsOpen(true)}>
                  <SlidersHorizontal />
                  运行参数
                </Button>
                <Button variant="outline" onClick={refreshAll} disabled={job.loading}>
                  <RefreshCw />
                  刷新
                </Button>
                {jobRow.status === 'running' && (
                  <Button variant="destructive" disabled={busy} onClick={() => setConfirm(true)}>
                    <CircleStop />
                    停止运行
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 border-t border-border pt-3 sm:grid-cols-4">
                {[
                  ['节点访问', `${facts?.nodeRuns.length ?? 0} 次`],
                  ['路由判定', `${facts?.routeDecisions.length ?? 0} 次`],
                  ['并行轮次', `${facts?.parallelRounds.length ?? 0} 轮`],
                  ['恢复记录', `${facts?.recoveries.length ?? 0} 次`],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {jobRow.error && (
            <Alert variant="error">
              <AlertDescription>运行失败：{jobRow.error}</AlertDescription>
            </Alert>
          )}
          <Dialog open={confirm} onOpenChange={setConfirm}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>停止运行 {jobRow.id}</DialogTitle>
                <DialogDescription>
                  停止会向该运行的进程组发送终止信号，已提交的节点事实保留。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost">取消</Button>
                </DialogClose>
                <Button variant="destructive" onClick={stop}>
                  确认停止
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog open={paramsOpen} onOpenChange={setParamsOpen}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>运行参数</DialogTitle>
                <DialogDescription>
                  启动时固定下来的配置与变量，之后修改不影响这次运行。
                </DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                {[
                  ['阶段', (run?.phase as string) || '·'],
                  ['工作目录', jobRow.cwd],
                  ['目录修订', jobRow.revision],
                  ['并发上限', String(jobRow.config.maxConcurrent)],
                  ['模型', jobRow.config.provider.model || '未配置'],
                  ['服务地址', jobRow.config.provider.baseUrl || '未配置'],
                ].map(([key, value]) => (
                  <div key={key} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{key}</dt>
                    <dd className="mt-0.5 break-words text-sm">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">启动变量</h3>
                <pre className="max-h-72">{json(jobRow.variables)}</pre>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost">关闭</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Tabs value={tab} onValueChange={(next) => update({ tab: next as 'flow' | 'nodes' })}>
            <TabsList>
              <TabsTrigger value="flow">
                <Network />
                Flow 流转
              </TabsTrigger>
              <TabsTrigger value="nodes">
                <Terminal />
                节点执行
              </TabsTrigger>
            </TabsList>
            <TabsContent value="flow" className="space-y-6 pt-4">
              <FlowPanel
                flow={flow}
                graph={graph}
                state={state}
                selectedRef={selected?.nodeRef}
                onSelect={openNode}
                facts={facts}
              />
              {children.length > 0 && (
                <Panel title="子 Run" meta={`${children.length} 个`}>
                  <ItemGroup>
                    {children.map((child) => (
                      <Item key={child.id} asChild>
                        <Link to={`/runs/${encodeURIComponent(child.id)}`}>
                          <ItemContent>
                            <ItemTitle>{child.id}</ItemTitle>
                            <ItemDescription>
                              {child.flowId} · {child.status}
                            </ItemDescription>
                          </ItemContent>
                          <ItemActions>
                            <ChevronRight className="size-4 text-muted-foreground" />
                          </ItemActions>
                        </Link>
                      </Item>
                    ))}
                  </ItemGroup>
                </Panel>
              )}
              {facts && facts.parallelRounds.length > 0 && (
                <Panel title="并行轮次" meta={`${facts.parallelRounds.length} 轮`}>
                  <ItemGroup>
                    {facts.parallelRounds.map((round) => (
                      <Item key={round.id}>
                        <ItemMedia>
                          <Network />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>{round.parallelRef}</ItemTitle>
                          <ItemDescription>
                            {Object.entries(round.branchStatuses)
                              .map(([branch, status]) => `${branch}: ${status}`)
                              .join(' · ')}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Status status={round.status} />
                        </ItemActions>
                      </Item>
                    ))}
                  </ItemGroup>
                </Panel>
              )}
              {facts && facts.recoveries.length > 0 && (
                <Panel title="恢复记录" meta={`${facts.recoveries.length} 次`}>
                  <ItemGroup>
                    {facts.recoveries.map((recovery) => (
                      <Item key={recovery.id}>
                        <ItemContent>
                          <ItemTitle className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{recovery.strategy}</Badge>
                            {recovery.summary}
                          </ItemTitle>
                          <ItemDescription>恢复于 {when(recovery.resumedAt)}</ItemDescription>
                        </ItemContent>
                      </Item>
                    ))}
                  </ItemGroup>
                </Panel>
              )}
            </TabsContent>
            <TabsContent value="nodes" className="pt-4">
              <NodeExecutions
                source={source}
                runId={id}
                facts={facts}
                selected={selected}
                live={jobRow.status === 'running'}
                onSelect={(node) => update({ tab: 'nodes', node: node.id })}
                onShowFlow={() => update({ tab: 'flow' })}
              />
            </TabsContent>
          </Tabs>
          {facts && (
            <Panel title="原始事实" meta="运行事实 JSON">
              <div className="rounded-xl border border-border bg-card">
                <details>
                  <summary className="px-4 py-3 text-sm text-txt2">展开查看</summary>
                  <pre className="max-h-96 rounded-t-none border-t border-border">{json({ ...facts, job: undefined })}</pre>
                </details>
              </div>
            </Panel>
          )}
        </>
      )}
    </main>
  )
}

function FlowPanel({
  flow,
  graph,
  state,
  selectedRef,
  onSelect,
  facts,
}: {
  flow: Loaded<FlowPackage>
  graph: { graph: FlowGraph; kinds: Record<string, ActionKind | undefined> } | null
  state?: ReturnType<typeof runFlowState>
  selectedRef?: string
  onSelect: (ref: string) => void
  facts?: RunHistory
}) {
  const current = state?.currentRef
    ? graph?.graph.nodes.find((node) => node.ref === state.currentRef)?.name
    : undefined
  // 判定去向按图形里的节点名显示，读到旧修订里已删掉的引用时退回引用本身。
  const names: Record<string, string> = {}
  for (const node of graph?.graph.nodes ?? []) names[node.ref] = node.name
  return (
    <>
      <Panel
        title={
          <>
            <Network />
            流转图
          </>
        }
        meta={current ? `当前节点：${current}` : undefined}
      >
        {flow.error ? (
          <Alert variant="error">
            <AlertDescription>
              这次运行使用的流程修订已经不可读取（{flow.error}），因此没有流转图。节点执行记录与下方记录仍然完整。
            </AlertDescription>
          </Alert>
        ) : !flow.value ? (
          <AsyncState state={flow} />
        ) : !graph || !state ? (
          <Alert variant="error">
            <AlertDescription>
              该修订的 FLOW.md 无法解析，暂时不能绘制流转图。节点执行记录仍可查看。
            </AlertDescription>
          </Alert>
        ) : (
          <RunGraph
            graph={graph.graph}
            actionKinds={graph.kinds}
            state={state}
            selected={selectedRef}
            onSelect={onSelect}
          />
        )}
      </Panel>
      <RouteRecords facts={facts} names={names} onOpenNode={onSelect} />
    </>
  )
}

/** 路由记录：节点开始、节点结束与路由判定按时间排在一起，点开看当时的入参与提交。 */
function RouteRecords({
  facts,
  names,
  onOpenNode,
}: {
  facts?: RunHistory
  names: Record<string, string>
  onOpenNode: (ref: string) => void
}) {
  const records = useMemo(() => (facts ? routeRecords(facts) : []), [facts])
  const [openId, setOpenId] = useState('')
  const open = records.find((record) => record.id === openId)
  const nameOf = (ref: string) =>
    names[ref] ?? facts?.nodeRuns.find((node) => node.nodeRef === ref)?.nodeName ?? ref
  return (
    <Panel
      title={
        <>
          <ListOrdered />
          路由记录
        </>
      }
      meta={
        facts
          ? `${records.length} 条 · ${facts.nodeRuns.length} 次节点访问 · ${facts.routeDecisions.length} 次判定`
          : '读取中…'
      }
    >
      {!facts ? (
        <p className="text-sm text-muted-foreground">正在读取路由记录…</p>
      ) : !records.length ? (
        <Empty>
          <EmptyMedia>
            <ListOrdered />
          </EmptyMedia>
          <EmptyTitle>这次运行还没有节点开始或路由判定</EmptyTitle>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {['时间', '事件', '节点', '内容', ''].map((cell, index) => (
                <TableHead
                  key={cell || index}
                  className={index === 0 ? 'w-24' : index === 4 ? 'w-14' : undefined}
                >
                  {cell}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((record) => (
              <TableRow key={record.id} className="group">
                <TableCell className="whitespace-nowrap py-2.5 font-mono text-xs text-muted-foreground">
                  {clock(record.at)}
                </TableCell>
                <TableCell className="py-2.5">
                  <Badge
                    variant={
                      record.kind === 'start'
                        ? 'info'
                        : record.kind === 'decision'
                          ? 'outline'
                          : record.nodeRun?.error
                            ? 'err'
                            : 'ok'
                    }
                  >
                    {record.kind === 'start' ? '开始' : record.kind === 'finish' ? '结束' : '判定'}
                  </Badge>
                </TableCell>
                <TableCell className="py-2.5">
                  {record.nodeRun ? (
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <b className="font-medium text-foreground">{nodeLabel(record.nodeRun)}</b>
                      <code className="text-[11px] text-muted-foreground">
                        {record.nodeRun.nodeRef}
                      </code>
                    </span>
                  ) : record.decision ? (
                    <span className="text-muted-foreground">
                      来自 {refName(facts, record.decision.sourceNodeRunId)}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="py-2.5 text-sm">
                  {record.nodeRun ? (
                    record.kind === 'start' ? (
                      <span className="text-muted-foreground">{record.nodeRun.actionKind}</span>
                    ) : (
                      finishSummary(record.nodeRun)
                    )
                  ) : record.decision ? (
                    decisionSummary(record.decision, nameOf)
                  ) : null}
                </TableCell>
                <TableCell className="py-2.5 text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`查看${record.kind === 'start' ? '节点开始' : record.kind === 'finish' ? '节点结束' : '路由判定'}记录`}
                    onClick={() => setOpenId(record.id)}
                  >
                    <ChevronRight />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={Boolean(open)} onOpenChange={(next) => !next && setOpenId('')}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {open?.nodeRun && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {open.kind === 'start' ? '节点开始' : '节点结束'} · {nodeLabel(open.nodeRun)}
                </DialogTitle>
                <DialogDescription>
                  <code>{open.nodeRun.nodeRef}</code> · {open.nodeRun.actionKind} · {when(open.at)}
                  {open.kind === 'finish' &&
                    ` · 耗时 ${duration(open.nodeRun.startedAt, open.nodeRun.completedAt)}`}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {open.kind === 'start' ? '入参' : '提交的结果'}
                  </h3>
                  <pre className="m-0 max-h-72">
                    {open.kind === 'start'
                      ? json(open.nodeRun.input)
                      : json(open.nodeRun.outcome ?? open.nodeRun.error ?? null)}
                  </pre>
                </div>
                {open.kind === 'start' ? (
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">进入方式</dt>
                      <dd className="mt-0.5 text-sm">{enteredFromLabel(open.nodeRun.enteredFrom)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">开始时间</dt>
                      <dd className="mt-0.5 text-sm">{when(open.nodeRun.startedAt)}</dd>
                    </div>
                    {open.nodeRun.session && (
                      <div className="min-w-0 sm:col-span-2">
                        <dt className="text-xs text-muted-foreground">Pi 会话</dt>
                        <dd className="mt-0.5 break-words text-sm">
                          {open.nodeRun.session.id}
                          {open.nodeRun.session.sessionReference
                            ? ` · ${open.nodeRun.session.sessionReference}`
                            : ''}
                        </dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  <div className="space-y-3">
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                      <div>
                        <dt className="text-xs text-muted-foreground">节点状态</dt>
                        <dd className="mt-0.5">
                          <Status status={open.nodeRun.status} />
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">完成时间</dt>
                        <dd className="mt-0.5 text-sm">{when(open.nodeRun.completedAt)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">进入方式</dt>
                        <dd className="mt-0.5 text-sm">
                          {enteredFromLabel(open.nodeRun.enteredFrom)}
                        </dd>
                      </div>
                    </dl>
                    {open.nodeRun.commandResult && (
                      <div className="space-y-1">
                        <h3 className="text-xs font-medium text-muted-foreground">
                          命令输出 · 退出码 {open.nodeRun.commandResult.exitCode ?? '·'}
                        </h3>
                        <pre className="m-0 max-h-52">
                          {open.nodeRun.commandResult.stdout || '（无标准输出）'}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost">关闭</Button>
                </DialogClose>
                <Button
                  onClick={() => {
                    setOpenId('')
                    onOpenNode(open.nodeRun!.nodeRef)
                  }}
                >
                  查看节点执行
                </Button>
              </DialogFooter>
            </>
          )}
          {open?.decision && (
            <>
              <DialogHeader>
                <DialogTitle>路由判定 · {open.decision.result}</DialogTitle>
                <DialogDescription>
                  来自 {refName(facts!, open.decision.sourceNodeRunId)} · {when(open.at)}
                </DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">结果</dt>
                  <dd className="mt-0.5 text-sm">{open.decision.result}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">去向</dt>
                  <dd className="mt-0.5 text-sm">
                    {open.decision.destination.kind === 'finish'
                      ? '结束这次运行'
                      : `${nameOf(open.decision.destination.ref)} · ${open.decision.destination.ref}`}
                  </dd>
                </div>
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">判定记录</dt>
                  <dd className="mt-1">
                    <pre className="m-0 max-h-60">{json(open.decision)}</pre>
                  </dd>
                </div>
              </dl>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost">关闭</Button>
                </DialogClose>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Panel>
  )
}

function NodeExecutions({
  source,
  runId,
  facts,
  selected,
  live,
  onSelect,
  onShowFlow,
}: {
  source: Source
  runId: string
  facts?: RunHistory
  selected?: NodeRun
  live: boolean
  onSelect: (node: NodeRun) => void
  onShowFlow: () => void
}) {
  if (!facts)
    return (
      <Empty role="status">
        <EmptyMedia>
          <History />
        </EmptyMedia>
        <EmptyTitle>正在读取节点执行记录…</EmptyTitle>
      </Empty>
    )
  if (!facts.nodeRuns.length)
    return (
      <Empty>
        <EmptyMedia>
          <Terminal />
        </EmptyMedia>
        <EmptyTitle>还没有节点执行记录</EmptyTitle>
      </Empty>
    )
  const rows = [...facts.nodeRuns].sort((left, right) => left.sequence - right.sequence)
  // 同一节点可能被多次访问，列表与详情都要能说清是第几次。
  const totals = new Map<string, number>()
  for (const row of rows) totals.set(row.nodeRef, (totals.get(row.nodeRef) ?? 0) + 1)
  const seen = new Map<string, number>()
  const visits = new Map<string, { ordinal: number; total: number }>()
  for (const row of rows) {
    const ordinal = (seen.get(row.nodeRef) ?? 0) + 1
    seen.set(row.nodeRef, ordinal)
    visits.set(row.id, { ordinal, total: totals.get(row.nodeRef) ?? 1 })
  }
  const index = selected ? rows.findIndex((row) => row.id === selected.id) + 1 : 0
  return (
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
      <Card className="min-w-0">
        <CardHeader className="items-center gap-2 border-b border-border px-3 py-2.5">
          <CardTitle className="text-sm">节点访问</CardTitle>
          <span className="text-xs text-muted-foreground">{rows.length} 条</span>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[calc(100vh-14rem)] overflow-auto">
            {rows.map((node) => {
              const visit = visits.get(node.id)!
              const active = selected?.id === node.id
              return (
                <button
                  key={node.id}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-elevated/60',
                    active && 'bg-accent-dim hover:bg-accent-dim',
                  )}
                  data-active={active}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(node)}
                >
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-txt3">
                    {node.sequence}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-[13px] font-medium leading-4',
                        active ? 'text-accent-2' : 'text-foreground',
                      )}
                    >
                      {nodeLabel(node)}
                    </span>
                    <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                      {node.actionKind}
                      {visit.total > 1 ? ` · 第 ${visit.ordinal} 次` : ''}
                    </span>
                  </span>
                  <Status status={node.status} />
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>
      <div className="min-w-0">
        {selected ? (
          <NodeDetail
            key={selected.id}
            source={source}
            runId={runId}
            node={selected}
            index={index}
            total={rows.length}
            visit={visits.get(selected.id)!}
            live={live}
            onShowFlow={onShowFlow}
          />
        ) : (
          <Empty>
            <EmptyMedia>
              <History />
            </EmptyMedia>
            <EmptyTitle>从左侧选择一条节点执行记录</EmptyTitle>
          </Empty>
        )}
      </div>
    </div>
  )
}

function NodeDetail({
  source,
  runId,
  node,
  index,
  total,
  visit,
  live,
  onShowFlow,
}: {
  source: Source
  runId: string
  node: NodeRun
  index: number
  total: number
  visit: { ordinal: number; total: number }
  live: boolean
  onShowFlow: () => void
}) {
  const session = node.session?.sessionReference
  const agent = isAgent(node)
  const trajectory = useLoad(
    (signal) =>
      agent && session ? source.trajectory(runId, node.id, signal) : Promise.resolve(undefined),
    [source, runId, node.id, session, agent],
  )
  const { refresh: reloadTrajectory } = trajectory
  useEffect(() => {
    if (!live || !agent || node.status !== 'running') return
    const timer = setTimeout(reloadTrajectory, 5000)
    return () => clearTimeout(timer)
  }, [live, agent, node.status, reloadTrajectory])
  return (
    <Card>
      <CardHeader className="gap-3 border-b border-border">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-base font-semibold">{nodeLabel(node)}</h2>
            <code className={mono}>{node.nodeRef}</code>
            <Status status={node.status} />
            <Badge variant="outline">{node.actionKind}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            第 {index} / 共 {total} 条{visit.total > 1 ? ` · 第 ${visit.ordinal} 次访问` : ''} · 耗时{' '}
            {duration(node.startedAt, node.completedAt)}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onShowFlow}>
          <Network />
          在流转图中查看
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">开始</dt>
            <dd className="mt-0.5 text-sm">{when(node.startedAt)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">完成</dt>
            <dd className="mt-0.5 text-sm">{when(node.completedAt)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">进入方式</dt>
            <dd className="mt-0.5 text-sm">{enteredFromLabel(node.enteredFrom)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">提交结果</dt>
            <dd className="mt-0.5 text-sm">{node.outcome?.result ?? '·'}</dd>
          </div>
        </dl>
        {node.error && (
          <Alert variant="error">
            <AlertDescription>{node.error.summary}</AlertDescription>
          </Alert>
        )}
        {agent && !session && (
          <Alert variant="warning">
            <AlertDescription>
              这条记录没有 Pi 会话引用：旧运行或节点在建立会话前就结束了，因此没有轨迹可看。执行证据仍保留在下方。
            </AlertDescription>
          </Alert>
        )}
        {agent && session && (
          <div className="min-w-0">
            {trajectory.error ? (
              <Alert variant="error">
                <AlertDescription>{trajectory.error}</AlertDescription>
              </Alert>
            ) : !trajectory.value ? (
              <p className="text-sm text-muted-foreground">正在读取会话轨迹…</p>
            ) : trajectory.value.omitted ? (
              <Alert variant="error">
                <AlertDescription>
                  会话轨迹超过 {Math.round(trajectory.value.size / 1024 / 1024)}{' '}
                  MiB，页面不加载。完整文件在 Runtime 的运行目录下。
                </AlertDescription>
              </Alert>
            ) : (
              <Suspense fallback={<p className="text-sm text-muted-foreground">正在加载轨迹视图…</p>}>
                <RunTrajectory jsonl={trajectory.value.jsonl} />
              </Suspense>
            )}
          </div>
        )}
        {node.commandResult && (
          <div className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              命令输出
              <Badge variant={node.commandResult.exitCode === 0 ? 'ok' : 'err'}>
                退出码 {node.commandResult.exitCode ?? '·'}
              </Badge>
            </h3>
            <pre className="mt-0 max-h-72">{node.commandResult.stdout || '（无标准输出）'}</pre>
            {node.commandResult.stderr && (
              <pre className="mt-0 max-h-72 border border-err/30 bg-err/5 text-destructive">
                {node.commandResult.stderr}
              </pre>
            )}
          </div>
        )}
        {node.childRunId && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">子 Run</h3>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/runs/${encodeURIComponent(node.childRunId)}`}>
                {node.childRunId}
                <ChevronRight />
              </Link>
            </Button>
          </div>
        )}
        <div className="rounded-xl border border-border">
          <details>
            <summary className="px-4 py-3 text-sm text-txt2">执行证据</summary>
            <div className="grid gap-4 border-t border-border p-4 md:grid-cols-2">
              <div className="min-w-0">
                <h3 className="text-xs font-medium text-muted-foreground">输入</h3>
                <pre className="mt-1 max-h-64">{json(node.input)}</pre>
              </div>
              <div className="min-w-0">
                <h3 className="text-xs font-medium text-muted-foreground">结果</h3>
                <pre className="mt-1 max-h-64">{json(node.outcome ?? null)}</pre>
              </div>
              <div className="min-w-0">
                <h3 className="text-xs font-medium text-muted-foreground">来源</h3>
                <pre className="mt-1 max-h-64">{json(node.enteredFrom)}</pre>
              </div>
              {node.error && (
                <div className="min-w-0">
                  <h3 className="text-xs font-medium text-muted-foreground">错误</h3>
                  <pre className="mt-1 max-h-64">{json(node.error)}</pre>
                </div>
              )}
            </div>
            {node.retryOf && (
              <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                重试自 {node.retryOf}
              </p>
            )}
          </details>
        </div>
      </CardContent>
    </Card>
  )
}
