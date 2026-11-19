import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { FileCode2, FilePlus2, Play, RotateCcw, Save, ShieldCheck, Trash2, Workflow } from 'lucide-react'
import { AsyncState, Refresh, message, useLoad } from './main'
import type { FlowFiles, Source } from './data'

const idPattern = /^[A-Za-z0-9][\w-]{0,95}$/
const filePattern = /^(FLOW\.md|(references|scripts)\/(?:[^/\\]+\/)*[^/\\]+)$/
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

export function Flows({ source }: { source: Source }) {
  const state = useLoad((signal) => source.flows(signal), [source])
  const ids = state.value || []
  return (
    <main>
      <div className="heading">
        <div>
          <h1>Flow 包</h1>
          <small>已发布的流程目录，新运行使用当前修订</small>
        </div>
        <Refresh state={state} />
        <Link className="button primary" to="/flows/new">
          <FilePlus2 size={16} />
          创建 Flow
        </Link>
      </div>
      {!state.value ? (
        <AsyncState state={state} />
      ) : !ids.length ? (
        <div role="status" className="empty">
          <Workflow />
          暂无 Flow 包
          <Link className="button" to="/flows/new">
            创建第一个 Flow
          </Link>
        </div>
      ) : (
        <ul className="list">
          {ids.map((id) => (
            <li key={id}>
              <Link to={`/flows/${encodeURIComponent(id)}/edit`}>
                <span className="cube">
                  <Workflow size={18} />
                </span>
                <span className="identity">
                  <b>{id}</b>
                  <small>编辑包文件并发起运行</small>
                </span>
                <span className="muted">编辑</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <footer>共 {ids.length} 个 Flow 包</footer>
    </main>
  )
}

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
  const [dirty, setDirty] = useState(!editing)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [newPath, setNewPath] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [running, setRunning] = useState(false)
  const [runId, setRunId] = useState('')
  const [variables, setVariables] = useState('{}')
  const loadedId = useRef<string | null>(null)

  useEffect(() => {
    const pkg = loaded.value
    if (!pkg || loadedId.current === pkg.revision) return
    loadedId.current = pkg.revision
    setName(pkg.id)
    setFiles(pkg.files)
    setRevision(pkg.revision)
    setDirty(false)
    setSelected(pkg.files['FLOW.md'] !== undefined ? 'FLOW.md' : Object.keys(pkg.files)[0])
  }, [loaded.value])

  if (editing && !loaded.value) {
    return (
      <main>
        <Link className="back" to="/flows">
          返回 Flow 包
        </Link>
        <AsyncState state={loaded} />
      </main>
    )
  }

  const write = (path: string, text: string) => {
    setFiles((current) => ({ ...current, [path]: text }))
    setDirty(true)
    setNotice('')
  }
  const removeFile = (path: string) => {
    if (path === 'FLOW.md') return
    setFiles((current) => {
      const next = { ...current }
      delete next[path]
      return next
    })
    if (selected === path) setSelected('FLOW.md')
    setDirty(true)
  }
  const addFile = () => {
    const path = newPath.trim()
    if (!filePattern.test(path) || path.split('/').some((part) => part === '.' || part === '..'))
      return setError('文件路径只能是 FLOW.md、references/ 或 scripts/ 下的文件')
    if (files[path] !== undefined) return setError('文件已存在')
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1))
      if (files[path.slice(0, i)] !== undefined) return setError('文件与目录重名')
    setError('')
    write(path, path.endsWith('.md') ? `# ${path.split('/').pop()?.replace(/\.md$/, '')}\n` : '')
    setSelected(path)
    setNewPath('')
  }
  const run = async (action: 'validate' | 'save' | 'delete') => {
    setBusy(action)
    setError('')
    setNotice('')
    try {
      if (action === 'validate') {
        if (!idPattern.test(name)) throw new Error('Flow 标识只能包含字母、数字、下划线和连字符')
        const result = await source.validate(name, files)
        setNotice(`校验通过：${result.id}`)
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
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy('')
    }
  }
  const start = async () => {
    setRunning(true)
    setError('')
    try {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(variables || '{}')
      } catch {
        throw new Error('启动变量必须是有效 JSON')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('启动变量必须是 JSON 对象')
      const run = await source.start(name, parsed, runId.trim() || undefined)
      navigate(`/runs/${encodeURIComponent(run.id)}`)
    } catch (e) {
      setError(message(e))
    } finally {
      setRunning(false)
    }
  }
  const readOnly = source.mode === 'demo'
  const paths = Object.keys(files).sort((a, b) =>
    a === 'FLOW.md' ? -1 : b === 'FLOW.md' ? 1 : a.localeCompare(b),
  )
  return (
    <main>
      <Link className="back" to="/flows">
        返回 Flow 包
      </Link>
      <div className="heading">
        <div>
          <h1>{editing ? name : '创建 Flow'}</h1>
          <small>
            {editing
              ? `当前修订 ${revision ? revision.slice(0, 8) : '未知'}`
              : '即时校验包文件，创建后进入编辑'}
            {dirty && ' · 有未保存修改'}
          </small>
        </div>
        <button onClick={() => run('validate')} disabled={readOnly || Boolean(busy)}>
          <ShieldCheck />
          校验
        </button>
        {editing && (
          <button
            onClick={loaded.refresh}
            disabled={Boolean(busy) || loaded.loading}
            title="丢弃未保存修改，读取已发布修订"
          >
            <RotateCcw />
            重新载入
          </button>
        )}
        <button onClick={() => run('save')} disabled={readOnly || Boolean(busy) || !dirty}>
          <Save />
          保存
        </button>
        {editing && (
          <button onClick={() => setConfirm(true)} disabled={readOnly || Boolean(busy)}>
            <Trash2 />
            删除
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
      {confirm && (
        <p className="warning" role="alert">
          删除 {name} 会移除当前修订中的整个包目录，已启动的运行仍可读取历史。
          <button onClick={() => setConfirm(false)}>取消</button>
          <button onClick={() => run('delete')}>确认删除</button>
        </p>
      )}
      <div className="editor">
        <aside>
          <label className="block">
            Flow 标识
            <input
              className="input mt-2"
              value={name}
              readOnly={editing}
              onChange={(event) => {
                setName(event.target.value)
                setDirty(true)
              }}
              placeholder="release-check"
            />
          </label>
          <h2 className="mt-4">
            <FileCode2 />
            包文件
          </h2>
          <ul className="files">
            {paths.map((path) => (
              <li key={path}>
                <button
                  aria-pressed={selected === path}
                  onClick={() => setSelected(path)}
                  className={selected === path ? 'file active' : 'file'}
                >
                  {path}
                </button>
                {path !== 'FLOW.md' && selected === path && (
                  <button
                    className="icon"
                    aria-label={`删除 ${path}`}
                    onClick={() => removeFile(path)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="add-file">
            <input
              className="input"
              aria-label="新增文件路径"
              placeholder="references/checklist.md"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addFile()
                }
              }}
            />
            <button onClick={addFile} aria-label="新增文件">
              <FilePlus2 />
            </button>
          </div>
          <p className="muted">
            只允许 FLOW.md、references/ 下的 Markdown 和 scripts/ 下的 ESM 脚本。
          </p>
        </aside>
        <section>
          <div className="tools">
            <h2>{selected}</h2>
            <small>{files[selected]?.split('\n').length || 0} 行</small>
          </div>
          <textarea
            aria-label={`${selected} 内容`}
            className="code"
            spellCheck={false}
            value={files[selected] ?? ''}
            onChange={(event) => write(selected, event.target.value)}
          />
        </section>
      </div>
      {editing && (
        <section>
          <div className="tools">
            <h2>
              <Play />
              启动运行
            </h2>
            <small>保存后的修订对新运行生效</small>
          </div>
          <div className="start-run">
            <label>
              Run ID（可选）
              <input
                className="input mt-2"
                value={runId}
                onChange={(event) => setRunId(event.target.value)}
                placeholder="自动生成"
              />
            </label>
            <label>
              启动变量（JSON）
              <textarea
                className="code short"
                aria-label="启动变量"
                value={variables}
                onChange={(event) => setVariables(event.target.value)}
              />
            </label>
            <label>
              工作区
              <input
                className="input mt-2"
                value="default"
                readOnly
                title={source.workspace?.path}
              />
            </label>
            <button
              className="primary"
              onClick={start}
              disabled={readOnly || running || dirty || busy === 'save'}
              title={dirty ? '请先保存包文件' : undefined}
            >
              <Play />
              {running ? '启动中…' : '启动运行'}
            </button>
          </div>
          {source.workspace && (
            <p className="muted">运行目录：{source.workspace.path}</p>
          )}
        </section>
      )}
      {readOnly && (
        <p className="muted">演示数据不连接 Runtime，保存、校验与启动都不可用。</p>
      )}
    </main>
  )
}
