import {
  Activity,
  Boxes,
  CircleAlert,
  CircleStop,
  Layers3,
  RefreshCw,
  Server,
} from 'lucide-react'
import { NavLink } from 'react-router'
import type { ModuleSidebarProps } from '@ursi/workspace-shell'
import { SidebarFrame } from '@ursi/workspace-shell'
import { AppRoot } from './AppRoot'
import { AsyncState, nameOf, statuses, useSandboxData } from './common'
import { CreateSandbox } from './Management'
import { Button } from './shared/ui/button'
import { Badge } from './shared/ui/badge'
import { cn } from './shared/lib/utils'
import type { Sandbox } from './data'

const filters = [
  ['', '全部实例', Layers3],
  ['running', '运行中', Activity],
  ['stopped', '已停止', CircleStop],
  ['error', '异常', CircleAlert],
] as const

function InstanceLink({ row }: { row: Sandbox }) {
  return (
    <NavLink
      to={'/sandboxes/' + row.id}
      end
      aria-label={'查看 ' + nameOf(row)}
      className="sbx-instance-link"
      title={nameOf(row)}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{nameOf(row)}</span>
        <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-sbx-txt2">
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 rounded-full border border-current',
                row.status === 'running' && 'bg-current',
              )}
            />
            {statuses[row.status] || row.status}
          </span>
          <span aria-hidden="true">·</span>
          <span className="truncate" title={row.spec.image}>
            {row.spec.image}
          </span>
        </span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-sbx-txt3">
        ›
      </span>
    </NavLink>
  )
}

/**
 * 沙箱侧边栏：模块导航 + 实例列表（筛选、创建、刷新）+ 折叠条。
 * 路由由外层 MemoryRouter / HashRouter 提供，点击实例即切换工作区详情。
 */
export function SandboxSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  const { config, list, status, setStatus } = useSandboxData()
  const source = config.value
  const rows = list.value ?? []
  const result = rows.filter((row) => !status || row.status === status)
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
  const running = counts.get('running') ?? 0

  return (
    <AppRoot>
      <SidebarFrame
        title="沙箱"
        collapsed={collapsed}
        collapse={collapse}
        expand={expand}
        items={[
          { label: '实例', value: String(rows.length) },
          ...(rows.length > 0 ? [{ label: '运行', value: String(running) }] : []),
        ]}
      >
        {!source ? (
          <div className="sbx-sidebar-config">
            <AsyncState state={config} />
          </div>
        ) : (
        <div className="sbx-sidebar">
          <nav className="sbx-sidebar-nav" aria-label="主导航">
            <NavLink className="sbx-nav-link" to="/sandboxes">
              沙箱
            </NavLink>
            {source && (
              <NavLink className="sbx-nav-link" to="/registry">
                能力注册表
              </NavLink>
            )}
            {source?.manage && source.capabilities.access_keys && (
              <NavLink className="sbx-nav-link" to="/access">
                接入配置
              </NavLink>
            )}
            <Badge variant="outline" className="sbx-sidebar-gateway">
              <Server className="size-3" />
              {source?.manage ? 'Gateway · 管理员' : source ? 'Gateway · 只读' : 'Gateway'}
            </Badge>
          </nav>

          <aside className="sbx-instance-sidebar" aria-labelledby="instances">
            <div className="sbx-instance-sidebar-head">
              <div className="flex items-center justify-between gap-2">
                <h2 id="instances" className="text-base">
                  实例列表
                </h2>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="刷新实例列表"
                  title="刷新实例列表"
                  onClick={list.refresh}
                  disabled={list.loading}
                >
                  <RefreshCw className={cn(list.loading && 'motion-safe:animate-spin')} />
                </Button>
              </div>
              {source && <CreateSandbox source={source} />}
              <div className="sbx-instance-filters" role="group" aria-label="按状态筛选">
                {filters.map(([value, label, Icon]) => (
                  <Button
                    key={value}
                    variant="ghost"
                    aria-pressed={status === value}
                    onClick={() => setStatus(value)}
                    className="h-8 justify-between gap-1 px-1.5 text-xs aria-pressed:bg-sbx-accent-dim aria-pressed:text-sbx-txt"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Icon aria-hidden="true" />
                      {label}
                    </span>
                    <span className="tabular-nums">
                      {list.value ? (value ? (counts.get(value) ?? 0) : rows.length) : '·'}
                    </span>
                  </Button>
                ))}
              </div>
            </div>

            <div className="sbx-instance-scroll">
              {(!list.value || list.error) && (
                <div className="p-3">
                  <AsyncState state={list} />
                </div>
              )}
              {list.value && !result.length && !list.error && (
                <div className="px-3 py-5 text-xs text-sbx-txt2">
                  <p role="status">{rows.length ? '没有匹配的实例' : '暂无沙箱实例'}</p>
                  {rows.length > 0 && (
                    <Button variant="link" size="sm" className="px-0" onClick={() => setStatus('')}>
                      显示全部
                    </Button>
                  )}
                </div>
              )}
              {result.length > 0 && (
                <ul className="divide-y divide-sbx-line" aria-labelledby="instances">
                  {result.map((row) => (
                    <li key={row.id}>
                      <InstanceLink row={row} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
        )}
      </SidebarFrame>
    </AppRoot>
  )
}
