import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Play, Plus, Square, Trash2 } from 'lucide-react'
import type { Sandbox, Source } from './data'

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
export function CreateSandbox({ source }: { source: Source }) {
  const navigate = useNavigate(),
    [open, show] = useState(false),
    [text, edit] = useState(template),
    [busy, wait] = useState(false),
    [error, fail] = useState('')
  const attempt = useRef({ body: '', key: '' })
  async function submit() {
    if (!source.create || busy) return
    wait(true)
    fail('')
    try {
      const spec = JSON.parse(text)
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
    <>
      <button aria-expanded={open} onClick={() => show(!open)}>
        <Plus />
        创建沙箱
      </button>
      {open && (
        <section className="basis-full space-y-3">
          <label className="block">
            创建规格（SandboxSpec JSON）
            <textarea
              className="mt-2 block w-full rounded-md border border-line bg-surface p-3 font-mono"
              rows={9}
              value={text}
              disabled={busy}
              onChange={(e) => edit(e.target.value)}
            />
          </label>
          {!source.manage && (
            <p>
              {source.demo ? '演示数据不连接 Gateway。' : '当前账户只读。'}{' '}
              提交需要 Gateway 管理员身份。
            </p>
          )}
          {error && (
            <p role="alert" className="warning">
              {error}
            </p>
          )}
          <button disabled={!source.manage || busy} onClick={submit}>
            {busy ? '提交中…' : '提交创建'}
          </button>
        </section>
      )}
    </>
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
        <button
          disabled={disabled || row.status !== 'stopped'}
          onClick={() => run('start')}
        >
          <Play />
          启动
        </button>
        <button
          disabled={disabled || row.status !== 'running'}
          onClick={() => run('stop')}
        >
          <Square />
          停止
        </button>
        <button disabled={disabled} onClick={() => ask(true)}>
          <Trash2 />
          删除
        </button>
      </div>
      {confirm && (
        <div className="warning" role="alert">
          删除 {row.spec.labels.name || row.id} 将永久清除容器和工作卷。
          <button onClick={() => ask(false)}>取消</button>{' '}
          <button onClick={() => run('delete')}>确认永久删除</button>
        </div>
      )}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {row.operation && (
        <p role="status">Gateway 正在处理：{row.operation.kind}</p>
      )}
    </section>
  )
}
export function CliTools() {
  return (
    <details className="mt-5">
      <summary>运行时工具（独立 CLI）</summary>
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
    </details>
  )
}
