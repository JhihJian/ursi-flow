import { useState } from 'react'
import { Save } from 'lucide-react'
import { AsyncState, PageHeading, message, useLoad } from './main'
import { Alert, AlertDescription } from './components/ui/alert'
import { Button } from './components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './components/ui/card'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'
import type { FlowConfig, Source } from './data'

export function Config({ source }: { source: Source }) {
  const loaded = useLoad((signal) => source.config(signal), [source])
  return (
    <main>
      <PageHeading
        title="运行配置"
        description="新运行使用当前配置，已在运行的 Run 保留启动时的配置"
      />
      {!loaded.value ? (
        <AsyncState state={loaded} />
      ) : (
        <ConfigForm source={source} initial={loaded.value} />
      )}
    </main>
  )
}

function ConfigForm({ source, initial }: { source: Source; initial: FlowConfig }) {
  const [saved, setSaved] = useState(initial)
  const [model, setModel] = useState(initial.model)
  const [limit, setLimit] = useState(String(initial.maxConcurrent))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const dirty = saved.model !== model || saved.maxConcurrent !== Number(limit)
  const save = async () => {
    const patch: Partial<FlowConfig> = {}
    if (saved.model !== model) patch.model = model
    if (saved.maxConcurrent !== Number(limit)) patch.maxConcurrent = Number(limit)
    setBusy(true)
    setError('')
    setSuccess(false)
    try {
      const updated = await source.configure(patch)
      setSaved(updated)
      setModel(updated.model)
      setLimit(String(updated.maxConcurrent))
      setSuccess(true)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="max-w-xl"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>执行器与并发</CardTitle>
        </CardHeader>
        <CardContent>
          <fieldset
            disabled={busy || source.mode === 'demo'}
            className="grid gap-4 disabled:opacity-70"
          >
            <div className="grid gap-1.5">
              <Label htmlFor="config-executor">执行器</Label>
              <Input id="config-executor" className="font-mono" readOnly value={saved.executor} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="config-model">模型</Label>
              <Input
                id="config-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="使用执行器默认模型"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="config-limit">最大并发数</Label>
              <Input
                id="config-limit"
                type="number"
                required
                min={1}
                max={64}
                step={1}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
              />
            </div>
            {error && (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {success && (
              <Alert variant="success">
                <AlertDescription role="status">配置已保存。</AlertDescription>
              </Alert>
            )}
            {source.mode === 'demo' && (
              <Alert>
                <AlertDescription>演示数据不能修改配置。</AlertDescription>
              </Alert>
            )}
          </fieldset>
        </CardContent>
        <CardFooter>
          <Button type="submit" variant="primary" disabled={!dirty || busy || source.mode === 'demo'}>
            <Save />
            保存配置
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}
