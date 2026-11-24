import { useEffect, useState } from 'react'
import { RefreshCw, Settings2 } from 'lucide-react'
import pi from '../../bundles/pi-agent/definition.json'
import browser from '../../bundles/browser/definition.json'
import {
  runtimeImages,
  type ImageInventory,
  type LogicalEndpoint,
  type Registry,
  type Source,
} from './data'
import { Alert } from './shared/ui/alert'
import { Badge } from './shared/ui/badge'
import { Button } from './shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './shared/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './shared/ui/table'
import { Textarea } from './shared/ui/textarea'

const modules = [
  {
    id: 'ssh',
    name: 'SSH / SFTP',
    environment:
      'URSI SSH 基础镜像（Ubuntu 24.04，级别 1），含 OpenSSH 和 supervisord',
    endpoints: [{ name: 'ssh', protocol: 'ssh', port: 2222 }],
  },
  {
    id: pi.bundles[0],
    name: 'Pi Agent',
    environment:
      '基于 SSH 镜像，需 pi-execution profile（级别 1），含 Node.js 和 Pi CLI',
    endpoints: pi.endpoints,
  },
  {
    id: browser.bundles[0],
    name: '浏览器桌面与 IDE',
    environment: '基于 Pi 镜像（级别 2），含 Chromium、桌面组件和 code-server',
    endpoints: browser.endpoints,
  },
]
const recipes = new Map<string, typeof modules>([
  [runtimeImages.ssh, modules.slice(0, 1)],
  [runtimeImages.pi, modules.slice(0, 2)],
  [runtimeImages.browser, modules],
])

function Endpoints({ endpoints }: { endpoints: LogicalEndpoint[] }) {
  if (!endpoints.length) return <span className="text-txt3">无端点</span>
  return (
    <ul className="space-y-0.5">
      {endpoints.map((endpoint) => (
        <li key={endpoint.name}>
          <code>{endpoint.name}</code>{' '}
          <span className="whitespace-nowrap text-xs text-txt3">
            {endpoint.protocol} · {endpoint.port}
          </span>
        </li>
      ))}
    </ul>
  )
}

function RegistryEditor({
  source,
  onSaved,
}: {
  source: Source
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || !source.registry) return
    const controller = new AbortController()
    source.registry(controller.signal).then(
      (registry) => {
        if (!controller.signal.aborted)
          setValue(JSON.stringify(registry, null, 2))
      },
      () => {
        if (!controller.signal.aborted) setError('读取注册表失败')
      },
    )
    return () => controller.abort()
  }, [open, source])
  async function save() {
    if (!source.replaceRegistry || busy || value === null) return
    setBusy(true)
    setError('')
    try {
      await source.replaceRegistry(JSON.parse(value) as Registry)
      setOpen(false)
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '注册表保存失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        setOpen(next)
        setValue(null)
        setError('')
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Settings2 />
          编辑 Gateway 注册表
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100%-2rem)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑 Gateway 注册表</DialogTitle>
          <DialogDescription>变更适用于之后创建的实例。</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert role="alert" className="text-err">
            {error}
          </Alert>
        )}
        {value === null ? (
          !error && <p role="status">正在读取注册表…</p>
        ) : (
          <Textarea
            aria-label="Gateway registry JSON"
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            className="min-h-64 w-full resize-y font-mono text-xs leading-5"
          />
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            取消
          </Button>
          <Button
            variant="primary"
            disabled={value === null}
            loading={busy}
            onClick={() => void save()}
          >
            保存配置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CapabilityRegistry({ source }: { source: Source }) {
  const [revision, refresh] = useState(0)
  const [result, setResult] = useState<ImageInventory | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    source.images(controller.signal).then(
      (inventory) => {
        if (!controller.signal.aborted) setResult(inventory)
      },
      (reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : '读取镜像清单失败',
          )
      },
    )
    return () => controller.abort()
  }, [source, revision])
  function reload() {
    setError('')
    setResult(null)
    refresh((value) => value + 1)
  }
  return (
    <main className="page-shell page-content space-y-8">
      <div className="page-heading">
        <h1>能力注册表</h1>
        {source.manage && (
          <RegistryEditor
            source={source}
            onSaved={() => {
              setNotice('Gateway 注册表已保存')
              reload()
            }}
          />
        )}
      </div>
      {notice && <Alert role="status">{notice}</Alert>}
      <section aria-labelledby="bundle-catalog" className="space-y-3">
        <h2 id="bundle-catalog" className="text-lg font-semibold">
          Bundle 管理
        </h2>
        <Table aria-label="原子 Bundle">
          <TableHeader>
            <TableRow>
              <TableHead>原子 Bundle</TableHead>
              <TableHead>适用镜像环境</TableHead>
              <TableHead>新增端点</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modules.map((module) => (
              <TableRow key={module.id}>
                <TableCell>
                  <span className="font-medium">{module.name}</span>
                  <code className="block text-xs text-txt3">{module.id}</code>
                </TableCell>
                <TableCell>{module.environment}</TableCell>
                <TableCell>
                  <Endpoints endpoints={module.endpoints} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <section aria-labelledby="image-catalog" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="image-catalog" className="text-lg font-semibold">
            镜像与组合能力
          </h2>
          <Button
            variant="outline"
            disabled={!result && !error}
            onClick={reload}
          >
            <RefreshCw />
            刷新镜像
          </Button>
        </div>
        {error ? (
          <Alert role="alert" className="text-err">
            读取镜像清单失败：{error}
          </Alert>
        ) : !result ? (
          <p role="status" className="text-sm text-txt3">
            正在查询镜像…
          </p>
        ) : (
          <>
            {result.inventory !== 'available' && (
              <Alert role="status">
                {result.inventory === 'unsupported'
                  ? '当前驱动不支持本机镜像查询'
                  : '暂时无法读取本机镜像'}
                ，仅展示 Gateway 登记。
              </Alert>
            )}
            {result.images.length === 0 ? (
              <p role="status" className="text-sm text-txt3">
                暂无本机 URSI 构建镜像或 Gateway 登记镜像
              </p>
            ) : (
              <Table aria-label="镜像与组合能力">
                <TableHeader>
                  <TableRow>
                    <TableHead>镜像</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>Bundle 组合</TableHead>
                    <TableHead>能力端点</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.images.map(
                    ({ reference, local_id: id, registered }) => {
                      const recipe = recipes.get(reference) ?? []
                      const valid =
                        registered && !('invalid' in registered)
                          ? registered
                          : null
                      const bundleIds =
                        valid?.bundles ??
                        (!registered ? recipe.map((module) => module.id) : [])
                      const endpoints =
                        valid?.endpoints ??
                        (!registered
                          ? recipe.flatMap((module) => module.endpoints)
                          : [])
                      return (
                        <TableRow key={reference}>
                          <TableCell>
                            <code className="break-all font-medium">
                              {reference}
                            </code>
                            {id && (
                              <code
                                title={id}
                                className="mt-1 block text-xs text-txt3"
                              >
                                {id.slice(0, 19)}
                              </code>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1.5">
                              {id ? (
                                <Badge variant="outline">本机已有</Badge>
                              ) : result.inventory === 'available' ? (
                                <Badge variant="outline">本机未查到</Badge>
                              ) : null}
                              <Badge variant="outline">
                                {valid
                                  ? '已登记'
                                  : registered
                                    ? '登记组合无效'
                                    : '未登记'}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell className="break-words">
                            {bundleIds.length ? (
                              <ul>
                                {bundleIds.map((id) => (
                                  <li key={id}>
                                    <code>{id}</code>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-txt3">无可用组合</span>
                            )}
                            {!registered && recipe.length > 0 && (
                              <span className="text-xs text-txt3">
                                构建配方
                              </span>
                            )}
                            {valid?.runtime_min_image_level != null && (
                              <span className="text-xs text-txt3">
                                归档要求镜像级别 ≥{' '}
                                {valid.runtime_min_image_level}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Endpoints endpoints={endpoints} />
                          </TableCell>
                        </TableRow>
                      )
                    },
                  )}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </section>
    </main>
  )
}
