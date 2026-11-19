import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Play, Plus, Square, Trash2 } from 'lucide-react'
import type { Sandbox, Source } from './data'
import { Button } from './shared/ui/button'
import { Textarea } from './shared/ui/textarea'
import { Input } from './shared/ui/input'
import { Label } from './shared/ui/label'
import { Alert } from './shared/ui/alert'
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './shared/ui/collapsible'

const template = JSON.stringify(
  {
    image: 'alpine:3.22',
    command: ['sleep', '3600'],
    labels: { name: 'my-sandbox' },
    memory_mb: 256,
    cpus: 1,
  },
  null,
  2,
)
const randomKey = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
type CreateMode = 'quick' | 'json'
function buildQuickSpec(
  image: string,
  name: string,
  command: string,
  memory: string,
  cpus: string,
) {
  if (!image.trim()) throw Error('请输入镜像名')
  const memoryMb = Number(memory)
  const cpuCount = Number(cpus)
  if (!Number.isInteger(memoryMb) || memoryMb < 16 || memoryMb > 65536)
    throw Error('内存必须是 16 到 65536 MiB 之间的整数')
  if (!Number.isFinite(cpuCount) || cpuCount <= 0 || cpuCount > 128)
    throw Error('CPU 必须大于 0 且不超过 128')
  return {
    image: image.trim(),
    command: command
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
    labels: name.trim() ? { name: name.trim() } : {},
    memory_mb: memoryMb,
    cpus: cpuCount,
  }
}
export function CreateSandbox({ source }: { source: Source }) {
  const navigate = useNavigate(),
    [open, show] = useState(false),
    [mode, setMode] = useState<CreateMode>('quick'),
    [image, setImage] = useState('alpine:3.22'),
    [name, setName] = useState('my-sandbox'),
    [command, setCommand] = useState('sleep\n3600'),
    [memory, setMemory] = useState('256'),
    [cpus, setCpus] = useState('1'),
    [text, edit] = useState(template),
    [busy, wait] = useState(false),
    [error, fail] = useState('')
  const attempt = useRef({ body: '', key: '' })
  function updateMode(next: CreateMode) {
    setMode(next)
    fail('')
  }
  async function submit() {
    if (!source.create || busy) return
    wait(true)
    fail('')
    try {
      const spec =
        mode === 'quick'
          ? buildQuickSpec(image, name, command, memory, cpus)
          : JSON.parse(text)
      if (!spec || typeof spec.image !== 'string' || !spec.image.trim())
        throw Error('规格必须包含 image 镜像名')
      const body = JSON.stringify(spec)
      if (attempt.current.body !== body)
        attempt.current = { body, key: randomKey() }
      const row = await source.create(spec, attempt.current.key)
      navigate('/sandboxes/' + row.id)
    } catch (e) {
      fail(e instanceof Error ? e.message : '创建请求失败')
    } finally {
      wait(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        show(next)
        if (next) fail('')
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus />
          创建沙箱
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-y-auto">
        <DialogHeader className="pr-8">
          <DialogTitle>创建沙箱</DialogTitle>
          <DialogDescription>
            快速填写常用配置，提交时自动生成符合 SandboxSpec 规范的 JSON。
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex gap-1 rounded-lg bg-elevated p-1"
          role="tablist"
          aria-label="创建方式"
        >
          {(
            [
              ['quick', '快速创建'],
              ['json', 'JSON 编辑'],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              variant={mode === value ? 'default' : 'ghost'}
              role="tab"
              aria-selected={mode === value}
              onClick={() => updateMode(value)}
              className="flex-1"
            >
              {label}
            </Button>
          ))}
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {mode === 'quick' ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="sandbox-image">镜像</Label>
                  <Input
                    id="sandbox-image"
                    value={image}
                    disabled={busy}
                    onChange={(e) => setImage(e.target.value)}
                    placeholder="例如 alpine:3.22"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sandbox-name">名称（可选）</Label>
                  <Input
                    id="sandbox-name"
                    value={name}
                    disabled={busy}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="my-sandbox"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sandbox-memory">内存（MiB）</Label>
                  <Input
                    id="sandbox-memory"
                    type="number"
                    min="16"
                    max="65536"
                    step="1"
                    value={memory}
                    disabled={busy}
                    onChange={(e) => setMemory(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sandbox-cpus">CPU</Label>
                  <Input
                    id="sandbox-cpus"
                    type="number"
                    min="0.1"
                    max="128"
                    step="0.1"
                    value={cpus}
                    disabled={busy}
                    onChange={(e) => setCpus(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sandbox-command">
                  命令参数（每行一个参数，可选）
                </Label>
                <Textarea
                  id="sandbox-command"
                  rows={3}
                  value={command}
                  disabled={busy}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={'sleep\n3600'}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="sandbox-spec">SandboxSpec JSON</Label>
              <Textarea
                id="sandbox-spec"
                rows={14}
                value={text}
                disabled={busy}
                onChange={(e) => edit(e.target.value)}
                className="min-h-64 w-full resize-y font-mono text-xs leading-5"
              />
            </div>
          )}
          {!source.manage && (
            <Alert className="border-warn/30 bg-warn/10 text-warn">
              {source.demo ? '演示数据不连接 Gateway。' : '当前账户只读。'}{' '}
              提交需要 Gateway 管理员身份。
            </Alert>
          )}
          {error && (
            <Alert className="border-err/30 bg-err/10 text-err">{error}</Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => show(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!source.manage}
              loading={busy}
            >
              提交创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
export function Actions({
  source,
  row,
  refresh,
}: {
  source: Source
  row: Sandbox
  refresh: (r: Sandbox) => void
}) {
  const [busy, wait] = useState(false),
    [error, fail] = useState(''),
    [confirm, ask] = useState(false)
  const disabled = !source.manage || busy || Boolean(row.operation)
  async function run(action: 'start' | 'stop' | 'delete') {
    if (disabled || !source.action) return
    wait(true)
    fail('')
    ask(false)
    try {
      refresh(await source.action(row.id, action))
    } catch (e) {
      fail(e instanceof Error ? e.message : '操作未确认，请刷新状态')
    } finally {
      wait(false)
    }
  }
  return (
    <section aria-label="生命周期操作">
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled || row.status !== 'stopped'}
          loading={busy}
          onClick={() => run('start')}
        >
          <Play />
          启动
        </Button>
        <Button
          disabled={disabled || row.status !== 'running'}
          loading={busy}
          onClick={() => run('stop')}
        >
          <Square />
          停止
        </Button>
        <Button
          variant="destructive"
          disabled={disabled}
          onClick={() => ask(true)}
        >
          <Trash2 />
          删除
        </Button>
      </div>
      <Dialog open={confirm} onOpenChange={ask}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除沙箱</DialogTitle>
            <DialogDescription>
              删除 {row.spec.labels.name || row.id}{' '}
              将永久清除容器和工作卷，此操作不能撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => ask(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => run('delete')}>
              确认永久删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error && (
        <Alert className="mt-3 border-err/30 bg-err/10 text-err">{error}</Alert>
      )}
      {row.operation && (
        <p role="status" className="mt-3 text-sm text-txt3">
          Gateway 正在处理：{row.operation.kind}
        </p>
      )}
    </section>
  )
}
export function CliTools() {
  return (
    <Collapsible className="mt-5">
      <CollapsibleTrigger className="text-sm font-medium text-txt2">
        运行时工具（独立 CLI）
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl>
          <div>
            <dt>ACP 会话</dt>
            <dd>
              acp initialize / new / prompt / status / cancel / close，连接
              Runtime 会话端点并使用会话令牌。
            </dd>
          </div>
          <div>
            <dt>工作区访问</dt>
            <dd>
              ssh 执行脚本，sftp-put / sftp-get 传输文件。使用本机 SSH 私钥及
              known_hosts。
            </dd>
          </div>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}
