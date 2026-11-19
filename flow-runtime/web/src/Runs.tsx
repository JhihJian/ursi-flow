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
  Terminal,
} from 'lucide-react'
import { AsyncState, PageHeading, Refresh, Status, message, useLoad, type Loaded } from './main'
import { Alert, AlertDescription } from './components/ui/alert'
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
  ItemGroup,
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
import type { FlowPackage, NodeRun, RunHistory, Source } from './data'
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
        <Table>
          <TableHeader>
            <TableRow>
              {['Run ID', 'Flow', '状态', '修订', '工作目录', ''].map((cell) => (
                <TableHead key={cell}>{cell}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link className="font-medium text-foreground hover:underline" to={`/runs/${encodeURIComponent(row.id)}`}>
                    {row.id}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link className="hover:underline" to={`/flows/${encodeURIComponent(row.flow)}/edit`}>
                    {row.flow}
                  </Link>
                </TableCell>
                <TableCell>
                  <Status status={row.status} />
                </TableCell>
                <TableCell className="font-mono" data-label="修订">
                  {row.revision.slice(0, 8)}
                </TableCell>
                <TableCell className="font-mono" data-label="工作目录">
                  {row.cwd}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon-sm" asChild>
                    <Link
                      to={`/runs/${encodeURIComponent(row.id)}`}
                      aria-label={`查看运行 ${row.id}`}
                      title="查看详情"
                    >
                      <ChevronRight />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

function Section({
  title,
  meta,
  children,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

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
    const params = new URLSearchParams()
    const target = next.tab ?? (tab === 'nodes' ? 'nodes' : 'flow')
    if (target === 'nodes') params.set('tab', 'nodes')
    const node = next.node ?? (target === 'nodes' ? selected?.id : undefined)
    if (node) params.set('node', node)
    setParams(params, { replace: true })
  }
  // 从图上点进节点：取该引用最近一次访问，回边场景下也落到刚跑过的那次。
  const openNode = (ref: string) => {
    const visits = (facts?.nodeRuns ?? []).filter((node) => node.nodeRef === ref)
    const latest = visits.sort((left, right) => right.sequence - left.sequence)[0]
    if (latest) update({ tab: 'nodes', node: latest.id })
  }

  return (
    <main className="space-y-4">
      <Link className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2')} to="/runs">
        <ArrowLeft />
        运行记录
      </Link>
      {!jobRow ? (
        <AsyncState state={job} />
      ) : (
        <>
          <PageHeading
            title={jobRow.id}
            description={`Flow ${jobRow.flow} · 修订 ${jobRow.revision.slice(0, 8)} · ${when((run?.startedAt as string) || undefined)}`}
            actions={
              <>
                <Status status={jobRow.status} />
                <Button onClick={refreshAll} disabled={job.loading}>
                  <RefreshCw />
                  刷新
                </Button>
                {jobRow.status === 'running' && (
                  <Button disabled={busy} onClick={() => setConfirm(true)}>
                    <CircleStop />
                    停止运行
                  </Button>
                )}
              </>
            }
          />
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
                  <Button>取消</Button>
                </DialogClose>
                <Button variant="destructive" onClick={stop}>
                  确认停止
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <details className="rounded-xl border border-line bg-surface px-4 py-3">
            <summary className="cursor-pointer text-sm text-txt2">运行参数与启动变量</summary>
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {Object.entries({
                状态: jobRow.status,
                阶段: (run?.phase as string) || '·',
                工作目录: jobRow.cwd,
                修订: jobRow.revision,
                并发上限: String(jobRow.config.maxConcurrent),
                模型: jobRow.config.provider.model || '未配置',
                服务地址: jobRow.config.provider.baseUrl || '未配置',
              }).map(([key, value]) => (
                <div key={key} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{key}</dt>
                  <dd className="mt-0.5 break-all text-sm">{value}</dd>
                </div>
              ))}
            </dl>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-txt2">启动变量</summary>
              <pre>{json(jobRow.variables)}</pre>
            </details>
          </details>
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
            <TabsContent value="flow" className="space-y-4 pt-4">
              <FlowPanel
                flow={flow}
                graph={graph}
                state={state}
                selectedRef={tab === 'nodes' ? selected?.nodeRef : undefined}
                onSelect={openNode}
                facts={facts}
              />
              {children.length > 0 && (
                <Section title="子 Run">
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
                </Section>
              )}
              {facts && facts.parallelRounds.length > 0 && (
                <Section title="并行轮次">
                  <ul className="divide-y divide-border">
                    {facts.parallelRounds.map((round) => (
                      <li key={round.id} className="flex flex-wrap items-center gap-2 py-2.5 first:pt-0 last:pb-0">
                        <b className="text-foreground">{round.parallelRef}</b>
                        <Status status={round.status} />
                        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                          {Object.entries(round.branchStatuses)
                            .map(([branch, status]) => `${branch}: ${status}`)
                            .join(' · ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              {facts && facts.recoveries.length > 0 && (
                <Section title="恢复记录">
                  <ul className="divide-y divide-border">
                    {facts.recoveries.map((recovery) => (
                      <li key={recovery.id} className="flex flex-wrap items-center gap-2 py-2.5 first:pt-0 last:pb-0">
                        <Badge variant="outline">{recovery.strategy}</Badge>
                        <span className="min-w-0 flex-1 text-sm">{recovery.summary}</span>
                        <span className="text-xs text-muted-foreground">{when(recovery.resumedAt)}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
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
              />
            </TabsContent>
          </Tabs>
          {facts && (
            <details>
              <summary className="cursor-pointer text-sm text-txt2">原始事实</summary>
              <pre>{json({ ...facts, job: undefined })}</pre>
            </details>
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
      <Section title="流转图" meta={current ? `当前节点：${current}` : undefined}>
        {flow.error ? (
          <Alert variant="error">
            <AlertDescription>
              这次运行使用的流程修订已经不可读取（{flow.error}），因此没有流转图。节点执行记录与下方证据仍然完整。
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
      </Section>
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
  const records = useMemo(
    () => (facts ? routeRecords(facts) : []),
    [facts],
  )
  const [openId, setOpenId] = useState('')
  const open = records.find((record) => record.id === openId)
  const nameOf = (ref: string) =>
    names[ref] ??
    facts?.nodeRuns.find((node) => node.nodeRef === ref)?.nodeName ??
    ref
  const decisions = facts?.routeDecisions.length ?? 0
  return (
    <Section
      title={
        <>
          <ListOrdered />
          路由记录
        </>
      }
      meta={
        facts
          ? `${records.length} 条 · ${facts.nodeRuns.length} 次节点访问 · ${decisions} 次判定`
          : '读取中…'
      }
    >
      {!facts ? (
        <p className="text-sm text-muted-foreground">正在读取路由记录…</p>
      ) : !records.length ? (
        <p className="text-sm text-muted-foreground">这次运行还没有节点开始或路由判定。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {['时间', '类型', '节点', '记录', ''].map((cell) => (
                <TableHead key={cell}>{cell}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((record) => (
              <TableRow key={record.id}>
                <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {clock(record.at)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" data-kind={record.kind}>
                    {record.kind === 'start' ? '开始' : record.kind === 'finish' ? '结束' : '判定'}
                  </Badge>
                </TableCell>
                <TableCell>
                  {record.nodeRun ? (
                    <span className="flex min-w-0 flex-wrap items-baseline gap-2">
                      <b className="font-medium text-foreground">{nodeLabel(record.nodeRun)}</b>
                      <code className="text-[11px] text-muted-foreground">{record.nodeRun.nodeRef}</code>
                    </span>
                  ) : record.decision ? (
                    <span className="text-muted-foreground">
                      来自 {refName(facts, record.decision.sourceNodeRunId)}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm">
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
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setOpenId(record.id)}>
                    查看
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={Boolean(open)} onOpenChange={(next) => !next && setOpenId('')}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-3xl">
          {open?.nodeRun && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {open.kind === 'start' ? '节点开始' : '节点结束'} · {nodeLabel(open.nodeRun)}
                </DialogTitle>
                <DialogDescription>
                  <code>{open.nodeRun.nodeRef}</code> · {open.nodeRun.actionKind} ·{' '}
                  {when(open.at)}
                  {open.kind === 'finish' &&
                    ` · 耗时 ${duration(open.nodeRun.startedAt, open.nodeRun.completedAt)}`}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3>{open.kind === 'start' ? '入参' : '提交的结果'}</h3>
                  <pre>
                    {open.kind === 'start'
                      ? json(open.nodeRun.input)
                      : json(
                          open.nodeRun.outcome ?? open.nodeRun.error ?? null,
                        )}
                  </pre>
                </div>
                {open.kind === 'start' ? (
                  <div className="space-y-4">
                    <div>
                      <h3>进入方式</h3>
                      <p className="text-sm">
                        {enteredFromLabel(open.nodeRun.enteredFrom)}
                      </p>
                      <pre>{json(open.nodeRun.enteredFrom)}</pre>
                    </div>
                    {open.nodeRun.session && (
                      <div>
                        <h3>会话</h3>
                        <pre>{json(open.nodeRun.session)}</pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <h3>状态</h3>
                      <dl className="text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-muted-foreground">节点状态</dt>
                          <dd>
                            <Status status={open.nodeRun.status} />
                          </dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">开始</dt>
                          <dd>{when(open.nodeRun.startedAt)}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">完成</dt>
                          <dd>{when(open.nodeRun.completedAt)}</dd>
                        </div>
                      </dl>
                    </div>
                    {open.nodeRun.commandResult && (
                      <div>
                        <h3>命令输出</h3>
                        <pre>{open.nodeRun.commandResult.stdout || '（无标准输出）'}</pre>
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
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3>判定</h3>
                  <pre>{json(open.decision)}</pre>
                </div>
                <div className="space-y-4">
                  <div>
                    <h3>去向</h3>
                    <p className="text-sm">
                      {open.decision.destination.kind === 'finish'
                        ? '结束这次运行'
                        : `${nameOf(open.decision.destination.ref)} · ${open.decision.destination.ref}`}
                    </p>
                  </div>
                  <div>
                    <h3>来源节点</h3>
                    <p className="text-sm">{refName(facts!, open.decision.sourceNodeRunId)}</p>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost">关闭</Button>
                </DialogClose>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  )
}

function NodeExecutions({
  source,
  runId,
  facts,
  selected,
  live,
  onSelect,
}: {
  source: Source
  runId: string
  facts?: RunHistory
  selected?: NodeRun
  live: boolean
  onSelect: (node: NodeRun) => void
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
    return <p className="text-sm text-muted-foreground">还没有节点执行记录。</p>
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
    <div className="execution-grid">
      <div className="execution-list" aria-label="节点执行记录">
        {rows.map((node) => {
          const visit = visits.get(node.id)!
          return (
            <button
              key={node.id}
              type="button"
              className="execution-row"
              data-active={selected?.id === node.id}
              aria-current={selected?.id === node.id ? 'true' : undefined}
              onClick={() => onSelect(node)}
            >
              <span className="w-6 shrink-0 font-mono text-[11px] text-txt3">{node.sequence}</span>
              <span className="min-w-0 flex-1">
                <b className="block truncate text-xs font-medium text-foreground">{nodeLabel(node)}</b>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {node.actionKind}
                  {visit.total > 1 ? ` · 第 ${visit.ordinal} 次` : ''}
                </span>
              </span>
              <Status status={node.status} />
            </button>
          )
        })}
      </div>
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
        />
      ) : (
        <p className="text-sm text-muted-foreground">从左侧选择一条节点执行记录。</p>
      )}
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
}: {
  source: Source
  runId: string
  node: NodeRun
  index: number
  total: number
  visit: { ordinal: number; total: number }
  live: boolean
}) {
  const session = node.session?.sessionReference
  const agent = isAgent(node)
  const trajectory = useLoad(
    (signal) =>
      agent && session
        ? source.trajectory(runId, node.id, signal)
        : Promise.resolve(undefined),
    [source, runId, node.id, session, agent],
  )
  const { refresh: reloadTrajectory } = trajectory
  useEffect(() => {
    if (!live || !agent || node.status !== 'running') return
    const timer = setTimeout(reloadTrajectory, 5000)
    return () => clearTimeout(timer)
  }, [live, agent, node.status, reloadTrajectory])
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 truncate text-base font-semibold">{nodeLabel(node)}</h2>
        <code className="text-xs text-muted-foreground">{node.nodeRef}</code>
        <Status status={node.status} />
        <span className="text-xs text-muted-foreground">
          第 {index} / 共 {total} 条 ·{' '}
          {visit.total > 1 ? `第 ${visit.ordinal} 次访问 · ` : ''}
          {duration(node.startedAt, node.completedAt)}
        </span>
      </div>
      {node.error && (
        <Alert variant="error">
          <AlertDescription>{node.error.summary}</AlertDescription>
        </Alert>
      )}
      {agent && !session && (
        <Alert variant="error">
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
                会话轨迹超过 {Math.round(trajectory.value.size / 1024 / 1024)} MiB，页面不加载。完整文件在
                Runtime 的运行目录下。
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
        <Section title="命令输出" meta={`退出码 ${node.commandResult.exitCode ?? '·'}`}>
          <pre>{node.commandResult.stdout || '（无标准输出）'}</pre>
          {node.commandResult.stderr && <pre className="text-destructive">{node.commandResult.stderr}</pre>}
        </Section>
      )}
      {node.childRunId && (
        <Section title="子 Run">
          <Link
            className="text-sm text-accent-2 hover:underline"
            to={`/runs/${encodeURIComponent(node.childRunId)}`}
          >
            {node.childRunId}
          </Link>
        </Section>
      )}
      <details className="rounded-xl border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm text-txt2">执行证据</summary>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <h3>输入</h3>
            <pre>{json(node.input)}</pre>
          </div>
          {node.outcome && (
            <div>
              <h3>结果</h3>
              <pre>{json(node.outcome)}</pre>
            </div>
          )}
          {node.error && (
            <div>
              <h3>错误</h3>
              <pre>{json(node.error)}</pre>
            </div>
          )}
          <div>
            <h3>来源</h3>
            <pre>{json(node.enteredFrom)}</pre>
          </div>
        </div>
        {node.retryOf && <p className="mt-2 text-xs text-muted-foreground">重试自 {node.retryOf}</p>}
      </details>
    </div>
  )
}
