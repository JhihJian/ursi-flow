import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  FileCode2,
  FilePlus2,
  GitBranch,
  Network,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  Workflow,
} from 'lucide-react'
import { AsyncState, Refresh, message, useLoad } from './main'
import { FlowCanvas } from './Graph'
import { Markdown, MarkdownEditor } from './Markdown'
import type { FlowFiles, Source } from './data'
import { parseFlow, serializeFlow, splitSections, joinSections, syncSections, setAction, setResults } from './flow/doc'
import { ACTION_KINDS, graphIssues, serializeGraph, type ActionKind, type FlowGraph } from './flow/graph'

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
                  <small>图形、文档与源码编辑</small>
                </span>
                <span className="muted">打开</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <footer>共 {ids.length} 个 Flow 包</footer>
    </main>
  )
}

type View = 'graph' | 'doc' | 'source'

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
  const [view, setView] = useState<View>('graph')
  const [dirty, setDirty] = useState(!editing)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [newPath, setNewPath] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [running, setRunning] = useState(false)
  const [runId, setRunId] = useState('')
  const [variables, setVariables] = useState('{}')
  const loadedRevision = useRef<string | null>(null)

  useEffect(() => {
    const pkg = loaded.value
    if (!pkg || loadedRevision.current === pkg.revision) return
    loadedRevision.current = pkg.revision
    setName(pkg.id)
    setFiles(pkg.files)
    setRevision(pkg.revision)
    setDirty(false)
    setSelected(pkg.files['FLOW.md'] !== undefined ? 'FLOW.md' : Object.keys(pkg.files)[0])
  }, [loaded.value])

  const flowText = files['FLOW.md'] ?? ''
  const parsed = useMemo(() => {
    try {
      return { doc: parseFlow(flowText), error: '' }
    } catch (cause) {
      return { doc: null, error: cause instanceof Error ? cause.message : 'FLOW.md 无法解析' }
    }
  }, [flowText])
  const parsedSections = useMemo(
    () => (parsed.doc ? splitSections(parsed.doc.post).sections : []),
    [parsed.doc],
  )
  const issues = useMemo(
    () => (parsed.doc ? graphIssues(parsed.doc.graph) : []),
    [parsed.doc],
  )

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

  const writeFile = (path: string, text: string) => {
    setFiles((current) => ({ ...current, [path]: text }))
    setDirty(true)
    setNotice('')
  }
  /** 用新图结构重写 FLOW.md，节点小节正文保持不变。 */
  const applyGraph = (next: FlowGraph) => {
    if (!parsed.doc) return
    const { prologue, sections } = splitSections(parsed.doc.post)
    const synced = syncSections(sections, parsed.doc.graph, next)
    writeFile(
      'FLOW.md',
      serializeFlow({ ...parsed.doc, graph: next, post: joinSections(prologue, synced) }),
    )
  }
  /** 改单个节点的动作类型或正文。 */
  const applyAction = (ref: string, change: { kind?: ActionKind; body?: string }) => {
    if (!parsed.doc) return
    const node = parsed.doc.graph.nodes.find((item) => item.ref === ref)
    if (!node) return
    const { prologue, sections } = splitSections(parsed.doc.post)
    const next = sections.map((section) => {
      if (section.name !== node.name) return section
      if (change.kind) {
        const kind = change.kind
        const withAction = setAction(section, kind)
        return setResults(
          withAction,
          parsed.doc!.graph.edges
            .filter((edge) => edge.from === ref && edge.result)
            .map((edge) => edge.result as string),
        )
      }
      const action = section.body.match(/```(新建Agent|复用Agent|执行自定义命令|执行Flow)[ \t]*\n([\s\S]*?)```/)
      if (!action || change.body === undefined) return section
      const body = section.body.replace(
        action[0],
        '```' + action[1] + '\n' + change.body.replace(/\s+$/, '') + '\n```',
      )
      return { ...section, body }
    })
    writeFile('FLOW.md', serializeFlow({ ...parsed.doc, post: joinSections(prologue, next) }))
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
    writeFile(path, path.endsWith('.md') ? `# ${path.split('/').pop()?.replace(/\.md$/, '')}\n` : '')
    setSelected(path)
    setView(path.endsWith('.md') ? 'doc' : 'source')
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
        setNotice(`校验通过：${result.id}${issues.length ? `（图结构仍有 ${issues.length} 处提示）` : ''}`)
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
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy('')
    }
  }
  const start = async () => {
    setRunning(true)
    setError('')
    try {
      let parsedVariables: Record<string, unknown>
      try {
        parsedVariables = JSON.parse(variables || '{}')
      } catch {
        throw new Error('启动变量必须是有效 JSON')
      }
      if (!parsedVariables || typeof parsedVariables !== 'object' || Array.isArray(parsedVariables))
        throw new Error('启动变量必须是 JSON 对象')
      const created = await source.start(name, parsedVariables, runId.trim() || undefined)
      navigate(`/runs/${encodeURIComponent(created.id)}`)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setRunning(false)
    }
  }
  const readOnly = source.mode === 'demo'
  const isMarkdown = selected.endsWith('.md')
  const paths = Object.keys(files).sort((a, b) =>
    a === 'FLOW.md' ? -1 : b === 'FLOW.md' ? 1 : a.localeCompare(b),
  )
  return (
    <main className="editor-page">
      <Link className="back" to="/flows">
        返回 Flow 包
      </Link>
      <div className="heading">
        <div>
          <h1>{editing ? name : '创建 Flow'}</h1>
          <small>
            {editing ? `当前修订 ${revision ? revision.slice(0, 8) : '未知'}` : '即时校验包文件，创建后进入编辑'}
            {dirty && ' · 有未保存修改'}
          </small>
        </div>
        <button onClick={() => run('validate')} disabled={readOnly || Boolean(busy)}>
          <ShieldCheck />
          校验
        </button>
        {editing && (
          <button onClick={loaded.refresh} disabled={Boolean(busy) || loaded.loading} title="丢弃未保存修改，读取已发布修订">
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

      <div className="editor-bar">
        <label className="bar-field">
          <span>Flow 标识</span>
          <input
            className="input"
            value={name}
            readOnly={editing}
            onChange={(event) => {
              setName(event.target.value)
              setDirty(true)
            }}
            placeholder="release-check"
          />
        </label>
        <div className="bar-files">
          <span className="bar-label">
            <FileCode2 size={13} />
            包文件
          </span>
          <ul className="files">
            {paths.map((path) => (
              <li key={path}>
                <button
                  aria-pressed={selected === path}
                  onClick={() => {
                    setSelected(path)
                    if (path !== 'FLOW.md' && view === 'graph') setView(path.endsWith('.md') ? 'doc' : 'source')
                    if (path === 'FLOW.md' && view === 'source' && parsed.doc) setView('graph')
                  }}
                  className={selected === path ? 'file active' : 'file'}
                >
                  <span className="file-name">{path}</span>
                </button>
                {path !== 'FLOW.md' && selected === path && (
                  <button className="icon" aria-label={`删除 ${path}`} onClick={() => removeFile(path)}>
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
            <button onClick={addFile} aria-label="新增文件" title="新增文件">
              <FilePlus2 />
            </button>
          </div>
        </div>
        {editing && (
          <div className="bar-run">
            <label className="bar-field">
              <span>Run ID（可选）</span>
              <input
                className="input"
                value={runId}
                onChange={(event) => setRunId(event.target.value)}
                placeholder="自动生成"
              />
            </label>
            <label className="bar-field">
              <span>启动变量（JSON）</span>
              <textarea
                className="code short"
                aria-label="启动变量"
                value={variables}
                onChange={(event) => setVariables(event.target.value)}
              />
            </label>
            <button
              className="primary"
              onClick={start}
              disabled={readOnly || running || dirty || busy === 'save'}
              title={dirty ? '请先保存包文件' : undefined}
            >
              <Play size={14} />
              {running ? '启动中…' : '启动运行'}
            </button>
          </div>
        )}
      </div>
      {readOnly && <p className="muted">演示数据不连接 Runtime，保存、校验与启动都不可用。</p>}

      <section className="editor-main">
          <div className="view-tabs" role="tablist" aria-label="编辑视图">
            <button
              role="tab"
              aria-selected={view === 'graph'}
              disabled={!parsed.doc}
              onClick={() => setView('graph')}
            >
              <Network size={14} />
              图形
            </button>
            <button
              role="tab"
              aria-selected={view === 'doc'}
              disabled={!isMarkdown}
              onClick={() => setView('doc')}
            >
              文档
            </button>
            <button role="tab" aria-selected={view === 'source'} onClick={() => setView('source')}>
              源码
            </button>
            <span className="view-tabs-note">{selected}</span>
            {issues.length > 0 && <span className="view-tabs-issues">{issues.length} 处结构提示</span>}
          </div>

          {view === 'graph' && parsed.doc && (
            <>
              {issues.length > 0 && (
                <ul className="issues-bar" role="status">
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
              <FlowCanvas
                graph={parsed.doc.graph}
                sections={parsedSections}
                issues={issues}
                onGraph={applyGraph}
                onAction={applyAction}
                onStart={() => {
                  void start()
                }}
              />
            </>
          )}
          {view === 'graph' && !parsed.doc && (
            <p role="alert" className="warning">
              {parsed.error}，请切到源码视图修复。
            </p>
          )}
          {view === 'doc' && (isMarkdown ? <MarkdownEditor
            value={files[selected] ?? ''}
            path={selected}
            onChange={(next) => writeFile(selected, next)}
            onOpenFile={(path) => {
              if (files[path] !== undefined) {
                setSelected(path)
                setView(path.endsWith('.md') ? 'doc' : 'source')
              } else setError(`包内没有 ${path}`)
            }}
          /> : <p className="muted">只有 Markdown 文件提供文档视图。</p>)}
          {view === 'source' &&
            (selected === 'FLOW.md' ? (
              <div className="source-wrap">
                <div className="source-bar">
                  <span className="muted">直接编辑 FLOW.md；图形与文档视图共用这段文本。</span>
                  <button
                    className="cchrome-btn"
                    onClick={() => {
                      if (!parsed.doc) return
                      const { prologue, sections } = splitSections(parsed.doc.post)
                      const synced = syncSections(sections, parsed.doc.graph, parsed.doc.graph)
                      writeFile(
                        'FLOW.md',
                        serializeFlow({ ...parsed.doc, post: joinSections(prologue, synced) }),
                      )
                      setNotice('已按图结构整理节点小节')
                    }}
                    disabled={!parsed.doc}
                  >
                    <GitBranch size={13} />
                    按图整理小节
                  </button>
                </div>
                <textarea
                  className="code"
                  aria-label="FLOW.md 内容"
                  spellCheck={false}
                  value={flowText}
                  onChange={(event) => writeFile('FLOW.md', event.target.value)}
                />
                <details>
                  <summary>图语句预览</summary>
                  <pre>{parsed.doc ? serializeGraph(parsed.doc.graph) : parsed.error}</pre>
                </details>
              </div>
            ) : (
              <textarea
                className="code"
                aria-label={`${selected} 内容`}
                spellCheck={false}
                value={files[selected] ?? ''}
                onChange={(event) => writeFile(selected, event.target.value)}
              />
            ))}
      </section>
    </main>
  )
}
