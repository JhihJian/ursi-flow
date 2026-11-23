import { useEffect, useReducer, useState } from 'react'
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import {
  type AccessReport,
  type ProfileAccess,
  type ProbeIdentity,
  type ProbeResult,
  type Source,
  GatewayError,
} from './data'
import { Alert } from './shared/ui/alert'
import { Badge } from './shared/ui/badge'
import { Button } from './shared/ui/button'
import { Input } from './shared/ui/input'
import { Label } from './shared/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './shared/ui/table'
import { Textarea } from './shared/ui/textarea'

const sshConfigCommand = 'ursi-sandbox-client ssh-config >> ~/.ssh/config'
const keygenCommand = 'ssh-keygen -t ed25519 -f ~/.ursi/id_ed25519 -N ""'
const probeReasons: Record<string, string> = {
  unconfigured: '控制台未配置探活身份私钥（URSI_WEB_SSH_KEY_FILE）',
  invalid_key: '控制台探活身份私钥无法读取或解析',
  auth_failed: '认证失败：控制台探活公钥可能尚未登记到该 Runtime Profile',
  not_running: '实例未运行或有待处理操作',
  endpoint_not_ready: 'SSH 端点未就绪',
  not_found: '实例不存在',
  gateway_error: 'Gateway 请求失败',
  tunnel_closed: '隧道关闭，Gateway 可能未启用隧道',
  ssh_unavailable: 'SSH 握手失败',
  exec_failed: '已登录但命令执行失败',
  timeout: '探活超时',
}
const statusNames: Record<string, string> = {
  running: '运行中',
  preparing: '准备中',
  stopped: '已停止',
  deleting: '删除中',
  error: '异常',
}

export function AccessSetup({ source }: { source: Source }) {
  const [revision, refresh] = useReducer((value) => value + 1, 0)
  const [report, setReport] = useState<AccessReport>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [profile, setProfile] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [identity, setIdentity] = useState<ProbeIdentity>()
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({})

  useEffect(() => {
    if (!source.accessKeys) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    source
      .accessKeys(controller.signal)
      .then((value) => {
        setReport(value)
        setError('')
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        if (cause instanceof GatewayError) setError(cause.message)
        else if (cause instanceof Error && cause.name !== 'AbortError')
          setError(cause.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [source, revision])

  useEffect(() => {
    let alive = true
    source
      .probeIdentity?.()
      .then((value) => {
        if (alive) setIdentity(value)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [source, revision])

  if (!source.accessKeys || !source.addAccessKey || !source.removeAccessKey)
    return (
      <main className="page-shell page-content space-y-4">
        <h1>接入配置</h1>
        <Alert>
          {'当前 Gateway 未启用 SSH 授权公钥管理。请在 Gateway 启动时设置 URSI_GATEWAY_ACCESS。'}
        </Alert>
      </main>
    )

  const profiles = report?.profiles ?? []
  const knownProfiles = [
    ...new Set([...profiles.map((item) => item.profile), profile].filter(Boolean)),
  ]

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const name = profile.trim()
    if (!name || !publicKey.trim()) {
      setError('请填写 Runtime Profile 名称和公钥内容')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await source.addAccessKey?.(name, publicKey.trim())
      if (next) setReport(next)
      setPublicKey('')
      setNotice(`已登记到 ${name}。新密钥对下次启动的沙箱生效，运行中的沙箱需重启。`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登记公钥失败')
    } finally {
      setBusy(false)
    }
  }

  async function remove(target: ProfileAccess, fingerprint: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await source.removeAccessKey?.(target.profile, fingerprint)
      if (next) setReport(next)
      setNotice(`已从 ${target.profile} 撤销该公钥。撤销只阻止后续登录，已建立的会话需停止沙箱才会断开。`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '撤销公钥失败')
    } finally {
      setBusy(false)
    }
  }

  async function probe(sandboxId: string) {
    setBusy(true)
    setError('')
    try {
      const result = await source.probeSandbox?.(sandboxId)
      if (result) setProbes((current) => ({ ...current, [sandboxId]: result }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '探活请求失败')
    } finally {
      setBusy(false)
    }
  }

  const consoleRegistered = Boolean(
    identity?.fingerprint &&
      profiles.some((item) => item.keys.some((key) => key.fingerprint === identity.fingerprint)),
  )

  return (
    <main className="page-shell page-content space-y-8">
      <div className="page-heading">
        <h1>接入配置</h1>
        <Button
          variant="outline"
          onClick={() => {
            setError('')
            setNotice('')
            refresh()
          }}
          disabled={loading}
        >
          <RefreshCw className="size-4" />
          刷新状态
        </Button>
      </div>
      {notice && <Alert role="status">{notice}</Alert>}
      {error && (
        <Alert role="alert" className="text-err">
          {error}
        </Alert>
      )}

      <section aria-labelledby="steps" className="space-y-4">
        <h2 id="steps" className="text-lg font-semibold">
          安装步骤
        </h2>
        <ol className="space-y-4">
          <li className="space-y-2">
            <h3 className="font-medium">1. 在本机生成密钥对</h3>
            <Command text={keygenCommand} />
            <p className="text-sm text-muted-foreground">
              {'私钥留在本机，只上传公钥。已有密钥时跳到下一步。'}
            </p>
          </li>
          <li className="space-y-3">
            <h3 className="font-medium">2. 登记公钥到 Runtime Profile</h3>
            <form className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-start" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="access-profile">Runtime Profile</Label>
                <Input
                  id="access-profile"
                  value={profile}
                  onChange={(event) => setProfile(event.target.value)}
                  list="access-profiles"
                  placeholder="如 pi 或 browser"
                  autoComplete="off"
                />
                <datalist id="access-profiles">
                  {knownProfiles.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="access-key">公钥（id_ed25519.pub 的内容）</Label>
                <Textarea
                  id="access-key"
                  value={publicKey}
                  onChange={(event) => setPublicKey(event.target.value)}
                  placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... 你的备注"
                  rows={3}
                  spellCheck={false}
                />
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" disabled={busy}>
                  <KeyRound className="size-4" />
                  登记公钥
                </Button>
              </div>
            </form>
            <Alert>
              {'公钥对该 Runtime Profile 下的所有沙箱生效，不是单实例授权。'}
            </Alert>
          </li>
          <li className="space-y-2">
            <h3 className="font-medium">3. 配置本机 SSH 客户端</h3>
            <Command text={sshConfigCommand} />
            <p className="text-sm text-muted-foreground">
              {'之后可直接使用 '}
              <code>ssh ursi-沙箱ID</code>
              {'，任意支持 ssh_config 的工具（含 pi 的 SSH 扩展）都可接入。'}
            </p>
          </li>
          <li className="space-y-2">
            <h3 className="font-medium">4. 验证</h3>
            <Command text="ssh ursi-沙箱ID 'echo ok'" />
            <p className="text-sm text-muted-foreground">
              {'客户端需能读取 URSI_GATEWAY_URL 与 URSI_GATEWAY_KEY_FILE 环境变量。'}
            </p>
          </li>
        </ol>
      </section>

      <section aria-labelledby="probe-identity" className="space-y-2">
        <h2 id="probe-identity" className="text-lg font-semibold">
          控制台探活身份
        </h2>
        {!identity?.configured && (
          <Alert>
            {probeReasons[identity?.reason ?? 'unconfigured']}
          </Alert>
        )}
        {identity?.configured && (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              {'控制台用自己的 SSH 身份真实登录一次实例，用来证明公钥已登记、已渲染、容器已挂载且 sshd 接受登录。它不会读取你的私钥。'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-xs">
                {identity.fingerprint}
              </code>
              <Badge variant="outline">
                {consoleRegistered ? '已登记' : '未登记'}
              </Badge>
            </div>
            {!consoleRegistered && profile && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !identity.public_key}
                onClick={() => {
                  setPublicKey(identity.public_key ?? '')
                  setNotice('已填入控制台探活公钥，确认 Runtime Profile 后提交即可登记。')
                }}
              >
                <KeyRound className="size-3.5" />
                填入登记表单
              </Button>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="state" className="space-y-3">
        <h2 id="state" className="text-lg font-semibold">
          状态
        </h2>
        {loading && !report && <p className="text-sm text-muted-foreground">正在读取…</p>}
        {report && profiles.length === 0 && (
          <p className="text-sm text-muted-foreground">尚未登记任何公钥。</p>
        )}
        {profiles.map((item) => (
          <ProfileCard
            key={item.profile}
            profile={item}
            busy={busy}
            probes={probes}
            canProbe={Boolean(source.probeSandbox)}
            onProbe={probe}
            onRemove={(fingerprint) => remove(item, fingerprint)}
          />
        ))}
        <p className="text-sm text-muted-foreground">
          {'状态只证明 Gateway 已登记并渲染公钥，以及容器是否已挂载该文件。它不证明某个私钥能登录，请用第 4 步自行验证。'}
        </p>
      </section>
    </main>
  )
}

function ProfileCard({
  profile,
  busy,
  probes,
  canProbe,
  onProbe,
  onRemove,
}: {
  profile: ProfileAccess
  busy: boolean
  probes: Record<string, ProbeResult>
  canProbe: boolean
  onProbe: (sandboxId: string) => void
  onRemove: (fingerprint: string) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{profile.profile}</h3>
        <Badge variant="outline">{profile.keys.length} 个公钥</Badge>
        {profile.rendered_at ? (
          <span className="text-sm text-muted-foreground">
            {`渲染于 ${new Date(profile.rendered_at * 1000).toLocaleString()}`}
          </span>
        ) : (
          <Badge variant="outline">尚未渲染</Badge>
        )}
      </div>
      <Table aria-label={`${profile.profile} 授权公钥`}>
        <TableHeader>
          <TableRow>
            <TableHead>指纹</TableHead>
            <TableHead>备注</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {profile.keys.map((key) => {
            const [, , ...rest] = key.key.split(' ')
            return (
              <TableRow key={key.fingerprint}>
                <TableCell className="font-mono text-xs">{key.fingerprint}</TableCell>
                <TableCell>{rest.join(' ') || '—'}</TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || profile.keys.length <= 1}
                    title={profile.keys.length <= 1 ? '不能删除最后一个公钥' : undefined}
                    onClick={() => onRemove(key.fingerprint)}
                  >
                    <Trash2 className="size-3.5" />
                    撤销
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <div className="space-y-1">
        <h4 className="text-sm font-medium">使用该 Profile 的沙箱</h4>
        {profile.sandboxes.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无实例。</p>
        ) : (
          <ul className="space-y-1">
            {profile.sandboxes.map((sandbox) => {
              const result = probes[sandbox.id]
              return (
                <li key={sandbox.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <code className="text-xs">{sandbox.id}</code>
                  <Badge variant="outline">
                    {statusNames[sandbox.status] ?? sandbox.status}
                  </Badge>
                  <span className="text-muted-foreground">
                    {sandbox.attached === true
                      ? '已挂载授权文件'
                      : sandbox.attached === false
                        ? '需重建才会带上授权挂载'
                        : '无挂载证据'}
                  </span>
                  {canProbe && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || sandbox.status !== 'running'}
                      onClick={() => onProbe(sandbox.id)}
                    >
                      <ShieldCheck className="size-3.5" />
                      真实登录探活
                    </Button>
                  )}
                  {result && (
                    <span
                      className={result.ok ? 'text-ok' : 'text-err'}
                      role="status"
                    >
                      {result.ok
                        ? `登录成功（${result.ms}ms），主机指纹 ${result.host_fingerprint}`
                        : probeReasons[result.reason ?? ''] ?? `探活失败：${result.reason}`}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 text-xs">
        <code>{text}</code>
      </pre>
      <Button variant="outline" size="sm" onClick={copy} aria-label="复制命令">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}
