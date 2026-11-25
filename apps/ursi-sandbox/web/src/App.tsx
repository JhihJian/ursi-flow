import { useEffect, useRef } from 'react'
import {
  Activity,
  ArrowLeft,
  Box,
  Boxes,
  ChevronDown,
  RefreshCw,
} from 'lucide-react'
import { Link, Route, Routes, useNavigate, useParams } from 'react-router'
import { ObservationRoute } from './ObservationPage'
import { EndpointWorkbench } from './Workbench'
import { Actions, CliTools } from './Management'
import { AccessSetup } from './AccessSetup'
import { CapabilityRegistry } from './CapabilityRegistry'
import { Button, buttonVariants } from './shared/ui/button'
import { Badge } from './shared/ui/badge'
import { Alert } from './shared/ui/alert'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './shared/ui/collapsible'
import { cn } from './shared/lib/utils'
import { GatewayError, type Source } from './data'
import {
  AsyncState,
  Refresh,
  StatusBadge,
  memory,
  nameOf,
  useLoad,
  useSandboxData,
} from './common'

/** 沙箱工作区：路由内容（实例详情、注册表、接入配置、网络观测）。 */
function InstanceOverview() {
  return (
    <main className="sbx-instance-overview" aria-labelledby="instances-heading">
      <Boxes aria-hidden="true" className="size-6 text-sbx-txt2" />
      <h1 id="instances-heading" className="text-lg">未选择实例</h1>
    </main>
  )
}
function InspectorSection({
  title,
  children,
  defaultOpen,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="border-b border-sbx-line last:border-0"
    >
      <h3>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="group h-11 w-full justify-between px-2 text-left"
          >
            <span>{title}</span>
            <ChevronDown className="text-sbx-txt3 transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="px-2 pb-4 pt-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
function Logs({ source, id }: { source: Source; id: string }) {
  const state = useLoad((s) => source.logs(id, s), [source, id])
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-sbx-txt3">最近 200 行</span>
        <Button
          variant="outline"
          size="sm"
          onClick={state.refresh}
          disabled={state.loading}
        >
          <RefreshCw />
          刷新日志
        </Button>
      </div>
      {(state.error || state.value === undefined) && (
        <AsyncState state={state} />
      )}
      {state.value !== undefined && (
        <pre
          tabIndex={0}
          aria-label="实例日志输出"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all border border-sbx-line bg-sbx-elevated p-3 text-xs leading-5 text-sbx-txt2"
        >
          {state.value || '暂无日志'}
        </pre>
      )}
    </div>
  )
}
function DetailsRoute({
  source,
  refreshList,
}: {
  source: Source
  refreshList: () => void
}) {
  const id = useParams<'id'>().id!
  return <Details key={id} source={source} id={id} refreshList={refreshList} />
}

function Details({
  source,
  id,
  refreshList,
}: {
  source: Source
  id: string
  refreshList: () => void
}) {
  const navigate = useNavigate(),
    deleting = useRef(false)
  const state = useLoad(
    async (signal) => {
      try {
        return await source.detail(id, signal)
      } catch (error) {
        if (
          !signal.aborted &&
          deleting.current &&
          error instanceof GatewayError &&
          error.status === 404
        )
          navigate('/sandboxes', { replace: true })
        throw error
      }
    },
    [source, id],
  )
  const row = state.value
  const lastListSnapshot = useRef<string>(undefined)
  const listSnapshot = row && `${row.revision}:${row.status}`
  useEffect(() => {
    if (!listSnapshot) return
    if (lastListSnapshot.current && lastListSnapshot.current !== listSnapshot) refreshList()
    lastListSnapshot.current = listSnapshot
  }, [listSnapshot, refreshList])
  useEffect(() => {
    if (!row?.operation || state.loading) return
    deleting.current = row.operation.kind === 'delete'
    const timer = setTimeout(state.refresh, 1000)
    return () => clearTimeout(timer)
  }, [row, source, state.refresh, state.loading])
  return (
    <main className="sbx-page-shell sbx-page-content space-y-4">
      <Link
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          '-ml-2',
        )}
        to="/sandboxes"
      >
        <ArrowLeft />
        实例列表
      </Link>
      {!row ? (
        <AsyncState state={state} />
      ) : (
        <>
          <div className="sbx-page-heading pb-1">
            <div className="flex min-w-0 items-start gap-3">
              <span className="sbx-icon-tile size-10 shrink-0">
                <Box className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h1 className="break-all">{nameOf(row)}</h1>
                  <StatusBadge status={row.status} />
                </div>
                <code className="break-all text-xs text-sbx-txt3">
                  {row.spec.labels.name ? row.id : row.spec.image}
                </code>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Refresh state={state} />
              {source.manage && (
                <Link
                  className={buttonVariants({ variant: 'outline' })}
                  to={`/sandboxes/${row.id}/observations`}
                >
                  <Activity />
                  网络观测
                </Link>
              )}
              <Actions source={source} row={row} refresh={state.update} />
            </div>
          </div>
          {row.operation && (
            <p role="status" className="text-sm text-sbx-txt3">
              Gateway 正在处理：{row.operation.kind}
            </p>
          )}
          {row.error && (
            <Alert className="border-sbx-err/30 bg-sbx-err/10 text-sbx-err">
              {row.error}
            </Alert>
          )}
          {state.error && <AsyncState state={state} />}
          <div className="sbx-detail-grid">
            <EndpointWorkbench
              key={`${row.id}:${row.resource.generation}`}
              row={row}
              source={source}
              snapshotFailed={Boolean(state.error)}
            />
            <aside
              aria-label="实例检查"
              className="sbx-detail-inspector"
            >
              <h2 className="px-2 pb-2 pt-1 text-xs font-semibold text-sbx-txt3">
                实例检查
              </h2>
              <InspectorSection title="实例规格" defaultOpen>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  {Object.entries({
                    镜像: row.spec.image,
                    资源配额: `${row.spec.cpus} CPU · ${memory(row.spec.memory_mb)}`,
                    '资源 / 数据代际': `${row.resource.generation} / ${row.resource.data_generation}`,
                    修订号: row.revision,
                    当前操作: row.operation?.kind || '无',
                    运行配置: row.spec.runtime_profile || '默认',
                  }).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-sbx-txt3">{k}</dt>
                      <dd className="break-all text-sbx-txt2">{v}</dd>
                    </div>
                  ))}
                </dl>
              </InspectorSection>
              <InspectorSection
                title={`服务端点（${row.endpoints.length}）`}
                defaultOpen
              >
                {row.endpoints.length ? (
                  <ul className="divide-y divide-sbx-line">
                    {row.endpoints.map((e) => (
                      <li
                        key={e.name}
                        className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0 break-all">
                          <div className="font-medium">{e.name}</div>
                          <code className="text-xs text-sbx-txt3">
                            {e.protocol} :{e.port} · {e.bundle}
                          </code>
                        </div>
                        <Badge
                          variant="outline"
                          className={
                            e.ready ? 'border-sbx-ok/20 text-sbx-ok' : 'text-sbx-txt3'
                          }
                        >
                          {e.ready ? '就绪' : '不可用'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-sbx-txt3">暂无端点</p>
                )}
              </InspectorSection>
              <InspectorSection title="实例日志">
                <Logs source={source} id={id} />
              </InspectorSection>
              <InspectorSection title="端点访问（独立 CLI）">
                <CliTools />
              </InspectorSection>
            </aside>
          </div>
        </>
      )}
    </main>
  )
}

export function SandboxRoutes() {
  const { config, list } = useSandboxData()
  const source = config.value
  if (!source) {
    // 配置的加载与错误状态由侧边栏统一展示，工作区这里不再放一个 status，
    // 避免同一件事出现两个互相冲突的状态位。
    return (
      <main className="sbx-page-shell sbx-page-content">
        <p className="text-sm text-sbx-txt3">
          {config.error ? `沙箱配置不可用：${config.error}` : '正在读取沙箱配置…'}
        </p>
      </main>
    )
  }
  return (
    <Routes>
      <Route index element={<InstanceOverview />} />
      <Route path="sandboxes" element={<InstanceOverview />} />
      <Route
        path="sandboxes/:id"
        element={<DetailsRoute source={source} refreshList={list.refresh} />}
      />
      <Route path="registry" element={<CapabilityRegistry source={source} />} />
      <Route path="access" element={<AccessSetup source={source} />} />
      <Route
        path="sandboxes/:id/observations/:run?"
        element={<ObservationRoute source={source} />}
      />
      <Route
        path="*"
        element={
          <main className="sbx-page-shell sbx-page-content">
            页面不存在 <Link to="/sandboxes">实例列表</Link>
          </main>
        }
      />
    </Routes>
  )
}
