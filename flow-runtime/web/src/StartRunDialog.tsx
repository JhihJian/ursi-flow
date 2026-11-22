// 启动运行对话框：按 FLOW.md 声明的全局变量生成表单，原始 JSON 作为高级入口。
import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, Play, SlidersHorizontal } from 'lucide-react'
import { Alert, AlertDescription } from './components/ui/alert'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'
import { Select } from './components/ui/select'
import { Textarea } from './components/ui/textarea'
import type { ExecutorRef } from './data'
import { analyzeParams, toText, toValue, type RunParam } from './flow/params'

export function StartRunDialog({
  open,
  onOpenChange,
  flowId,
  markdown,
  workspace,
  onStart,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  flowId: string
  markdown: string
  /** workspace 为空表示交给 Runtime 在工作区根目录下按 Run ID 新建。 */
  workspace?: string
  onStart: (
    variables: Record<string, unknown>,
    runId: string,
    cwd: string,
    executorRef?: ExecutorRef,
  ) => Promise<void>
}) {
  const analysis = useMemo(() => analyzeParams(markdown), [markdown])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [runId, setRunId] = useState('')
  const [cwd, setCwd] = useState('')
  const [executor, setExecutor] = useState('')
  const [revision, setRevision] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [raw, setRaw] = useState('{}')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)

  // 每次打开都按当前 FLOW.md 重新生成表单：默认值预填，其余留空。
  useEffect(() => {
    if (!open) return
    const next: Record<string, string> = {}
    for (const param of analysis.params) next[param.name] = toText(param.default)
    setDraft(next)
    setExecutor('')
    setRevision('')
    setRunId('')
    setCwd('')
    setAdvanced(false)
    setRaw('{}')
    setErrors({})
    setFailure('')
  }, [open, analysis])

  const declared = useMemo(
    () => new Set(analysis.params.map((param) => param.name)),
    [analysis],
  )

  const collectDraft = (): { variables: Record<string, unknown>; problems: Record<string, string> } => {
    const variables: Record<string, unknown> = {}
    const problems: Record<string, string> = {}
    for (const param of analysis.params) {
      const text = draft[param.name] ?? ''
      // 有默认值时留空就交给服务端取默认值，必填项留空算缺项。
      if (!text.trim()) {
        if (!param.hasDefault) problems[param.name] = '必填'
        continue
      }
      const parsed = toValue(param, text)
      if (parsed.error) problems[param.name] = parsed.error
      else variables[param.name] = parsed.value
    }
    return { variables, problems }
  }

  const switchMode = (next: boolean) => {
    setFailure('')
    setErrors({})
    if (next) {
      const { variables } = collectDraft()
      setRaw(JSON.stringify(variables, null, 2))
      setAdvanced(true)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      setFailure('高级 JSON 不是有效 JSON，修好后才能回到表单。')
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setFailure('高级 JSON 必须是对象。')
      return
    }
    const unknown = Object.keys(parsed).filter((name) => !declared.has(name))
    if (unknown.length) {
      setFailure(`未声明的启动变量：${unknown.join('、')}。节点自己提交的变量不需要在这里填。`)
      return
    }
    const next2: Record<string, string> = {}
    for (const param of analysis.params)
      next2[param.name] = toText((parsed as Record<string, unknown>)[param.name])
    setDraft(next2)
    setAdvanced(false)
  }

  const submit = async () => {
    setFailure('')
    let variables: Record<string, unknown>
    if (advanced) {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error('必须是 JSON 对象')
        variables = parsed as Record<string, unknown>
      } catch (error) {
        setFailure(`高级 JSON 不可用：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const unknown = Object.keys(variables).filter((name) => !declared.has(name))
      if (unknown.length) {
        setFailure(`未声明的启动变量：${unknown.join('、')}。节点自己提交的变量不需要在这里填。`)
        return
      }
      const missing = analysis.params.filter(
        (param) => !param.hasDefault && !Object.hasOwn(variables, param.name),
      )
      if (missing.length) {
        setFailure(`缺少必填变量：${missing.map((param) => param.name).join('、')}`)
        return
      }
    } else {
      const collected = collectDraft()
      setErrors(collected.problems)
      if (Object.keys(collected.problems).length) {
        setFailure('请补齐标记为必填的变量。')
        return
      }
      variables = collected.variables
    }
    setBusy(true)
    try {
      const id = executor.trim()
      const version = Number(revision)
      if ((id || revision) && (!id || !Number.isSafeInteger(version) || version < 1))
        throw new Error('平台执行器需要 ID 和正整数修订号。')
      await onStart(variables, runId.trim(), cwd.trim(), id ? { id, revision: version } : undefined)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const required = analysis.params.filter((param) => !param.hasDefault).length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-3rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>启动运行</DialogTitle>
          <DialogDescription>
            {analysis.flowName ? `${analysis.flowName} · ` : ''}
            {flowId}
            {analysis.params.length
              ? ` · ${analysis.params.length} 项启动变量${required ? `，${required} 项必填` : '，都有默认值'}`
              : ' · 无需启动变量'}
          </DialogDescription>
        </DialogHeader>

        {analysis.error && (
          <Alert variant="warning">
            <CircleAlert />
            <AlertDescription>{analysis.error}。可以用下面的高级 JSON 直接提供变量。</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-1.5 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="start-run-id">Run ID（可选）</Label>
            <Input
              id="start-run-id"
              className="font-mono"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
              placeholder="自动生成"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="start-run-cwd">工作目录（可选）</Label>
            <Input
              id="start-run-cwd"
              className="font-mono"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder={workspace ? `${workspace}/<Run ID>` : '工作区根目录未配置'}
            />
          </div>
        </div>
        <p className="-mt-1 text-xs text-muted-foreground">
          {workspace
            ? `留空则在 ${workspace} 下按 Run ID 新建目录作为本次运行的工作目录。`
            : '留空需要先在运行配置里填写工作区根目录；已有的绝对路径也可以直接填在右边。'}
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="start-executor">平台执行器 ID（可选）</Label>
            <Input id="start-executor" value={executor} onChange={e => setExecutor(e.target.value)} placeholder="留空使用本地 Pi" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="start-executor-revision">执行器修订号</Label>
            <Input id="start-executor-revision" type="number" min={1} step={1} value={revision} onChange={e => setRevision(e.target.value)} />
          </div>
        </div>

        {advanced ? (
          <div className="grid gap-1.5">
            <Label htmlFor="start-run-json">启动变量（JSON）</Label>
            <Textarea
              id="start-run-json"
              aria-label="启动变量"
              className="min-h-40 font-mono text-xs leading-5"
              spellCheck={false}
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              只接受元信息里声明过的全局变量，节点执行中产生的变量由运行时维护。
            </p>
          </div>
        ) : (
          <>
            {analysis.params.length === 0 ? (
              <p className="rounded-lg bg-elevated px-3 py-2.5 text-sm text-muted-foreground">
                这个 Flow 没有需要填写的启动变量。
              </p>
            ) : (
              <div className="grid gap-4">
                {analysis.params.map((param) => (
                  <ParamField
                    key={param.name}
                    param={param}
                    value={draft[param.name] ?? ''}
                    error={errors[param.name]}
                    onChange={(text) => {
                      setDraft((current) => ({ ...current, [param.name]: text }))
                      setErrors((current) => {
                        if (!current[param.name]) return current
                        const next = { ...current }
                        delete next[param.name]
                        return next
                      })
                    }}
                  />
                ))}
              </div>
            )}
            {analysis.internal.length > 0 && (
              <div className="rounded-lg border border-border px-3 py-2.5">
                <p className="text-xs text-muted-foreground">
                  过程中由节点写入、已有初始值的变量不需要填写：
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {analysis.internal.map((item) => (
                    <li key={item.name}>
                      <Badge variant="outline" title={item.description || item.name}>
                        {item.name}
                        {item.initial === undefined ? '' : `：${toText(item.initial)}`}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {failure && (
          <Alert variant="error">
            <CircleAlert />
            <AlertDescription role="alert">{failure}</AlertDescription>
          </Alert>
        )}

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={() => switchMode(!advanced)}>
            <SlidersHorizontal />
            {advanced ? '回到表单' : '高级：编辑 JSON'}
          </Button>
          <span className="flex items-center gap-2">
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
            <Button variant="primary" disabled={busy} onClick={submit}>
              <Play />
              {busy ? '启动中…' : '启动运行'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ParamField({
  param,
  value,
  error,
  onChange,
}: {
  param: RunParam
  value: string
  error?: string
  onChange: (next: string) => void
}) {
  const id = `start-var-${param.name}`
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id} className="text-sm text-foreground">
          {param.name}
        </Label>
        {param.hasDefault ? (
          <Badge>可选</Badge>
        ) : (
          <Badge variant="warn">必填</Badge>
        )}
        {!param.referenced && <Badge variant="outline">提示词未引用</Badge>}
      </div>
      {param.description && (
        <p className="text-xs text-muted-foreground">{param.description}</p>
      )}
      {param.kind === 'number' ? (
        <Input
          id={id}
          type="number"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : param.kind === 'boolean' ? (
        <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">未指定</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </Select>
      ) : param.kind === 'json' ? (
        <Textarea
          id={id}
          className="min-h-24 font-mono text-xs leading-5"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Textarea
          id={id}
          className="min-h-20"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={param.hasDefault ? '留空使用默认值' : '必填'}
        />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
