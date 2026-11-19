import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ChevronRight, CircleStop, History, Network, Terminal } from 'lucide-react'
import { AsyncState, PageHeading, Refresh, Status, message, useLoad } from './main'
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
  ItemGroup,
  ItemTitle,
} from './components/ui/item'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table'
import type { NodeRun, RunHistory, Source } from './data'
import { cn } from './lib/utils'

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

export function RunDetail({ source }: { source: Source }) {
  const id = useParams<'id'>().id!
  const job = useLoad((signal) => source.run(id, signal), [source, id])
  const history = useLoad((signal) => source.history(id, signal), [source, id])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const { refresh: reloadJob } = job
  const { refresh: reloadHistory } = history
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
                <Refresh state={job} />
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
          <Section title="运行参数">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
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
          </Section>
          <Section
            title="节点时间线"
            meta={facts ? `${facts.nodeRuns.length} 次访问` : '读取中…'}
          >
            {!facts ? (
              <AsyncState state={history} />
            ) : !facts.nodeRuns.length ? (
              <p className="text-sm text-muted-foreground">还没有节点执行记录。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {['#', '节点', '动作', '状态', '结果', '耗时', ''].map((cell) => (
                      <TableHead key={cell}>{cell}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {facts.nodeRuns.map((node) => (
                    <NodeRow
                      key={node.id}
                      node={node}
                      open={open === node.id}
                      toggle={() => setOpen(open === node.id ? null : node.id)}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
          <Section
            title={
              <>
                <Network />
                路由证据
              </>
            }
            meta={facts ? `${facts.routeDecisions.length} 次选择` : '读取中…'}
          >
            {!facts || facts.routeDecisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有路由记录。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {['#', '来源节点', '结果', '去向', '选择时间'].map((cell) => (
                      <TableHead key={cell}>{cell}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {facts.routeDecisions.map((decision) => (
                    <TableRow key={decision.id}>
                      <TableCell className="font-mono">{decision.sequence}</TableCell>
                      <TableCell>{refName(facts, decision.sourceNodeRunId)}</TableCell>
                      <TableCell>{decision.result}</TableCell>
                      <TableCell>
                        {decision.destination.kind === 'finish'
                          ? '结束'
                          : decision.destination.ref || decision.destination.kind}
                      </TableCell>
                      <TableCell>{when(decision.selectedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
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

function NodeRow({ node, open, toggle }: { node: NodeRun; open: boolean; toggle: () => void }) {
  return (
    <>
      <TableRow>
        <TableCell className="font-mono">{node.sequence}</TableCell>
        <TableCell>
          <b className="block font-medium text-foreground">{nodeLabel(node)}</b>
          <span className="block font-mono text-xs text-muted-foreground">{node.nodeRef}</span>
        </TableCell>
        <TableCell>{node.actionKind}</TableCell>
        <TableCell>
          <Status status={node.status} />
        </TableCell>
        <TableCell>{node.outcome?.result || node.error?.summary || '·'}</TableCell>
        <TableCell>{duration(node.startedAt, node.completedAt)}</TableCell>
        <TableCell className="text-right">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={open}
            onClick={toggle}
            title="执行证据"
            aria-label="执行证据"
          >
            <ChevronRight className={open ? 'rotate-90' : ''} />
          </Button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-base hover:bg-base">
          <TableCell colSpan={7}>
            <div className="grid gap-4 md:grid-cols-2">
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
              {node.commandResult && (
                <div className="md:col-span-2">
                  <h3 className="flex items-center gap-1.5">
                    <Terminal className="size-3.5" />
                    命令输出 · 退出码 {node.commandResult.exitCode ?? '·'}
                  </h3>
                  <pre>{node.commandResult.stdout || '（无标准输出）'}</pre>
                  {node.commandResult.stderr && <pre className="text-destructive">{node.commandResult.stderr}</pre>}
                </div>
              )}
              {node.childRunId && (
                <div>
                  <h3>子 Run</h3>
                  <Link
                    className="text-sm text-accent-2 hover:underline"
                    to={`/runs/${encodeURIComponent(node.childRunId)}`}
                  >
                    {node.childRunId}
                  </Link>
                </div>
              )}
              <div>
                <h3>来源</h3>
                <pre>{json(node.enteredFrom)}</pre>
              </div>
            </div>
            {node.retryOf && (
              <p className="mt-2 text-xs text-muted-foreground">重试自 {node.retryOf}</p>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
