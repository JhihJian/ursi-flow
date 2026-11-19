import { useState } from 'react'
import { Save } from 'lucide-react'
import { AsyncState, PageHeading, message, useLoad } from './main'
import { Alert, AlertDescription } from './components/ui/alert'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './components/ui/card'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'
import { Select } from './components/ui/select'
import {
  PROVIDER_APIS,
  THINKING_LEVELS,
  providerMissing,
  type FlowConfig,
  type ProviderConfig,
  type Source,
} from './data'

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

/** 表单只保留字符串，提交时按字段转换成对应类型。 */
interface Draft {
  baseUrl: string
  apiKey: string
  model: string
  api: string
  contextWindow: string
  maxTokens: string
  reasoning: boolean
  thinkingLevel: string
  maxConcurrent: string
}

const draftOf = (config: FlowConfig): Draft => ({
  baseUrl: config.provider.baseUrl ?? '',
  // 密钥不回传，留空表示沿用已保存的客户端密钥。
  apiKey: '',
  model: config.provider.model ?? '',
  api: config.provider.api ?? 'openai-completions',
  contextWindow: config.provider.contextWindow ? String(config.provider.contextWindow) : '',
  maxTokens: config.provider.maxTokens ? String(config.provider.maxTokens) : '',
  reasoning: config.provider.reasoning ?? false,
  thinkingLevel: config.provider.thinkingLevel ?? 'low',
  maxConcurrent: String(config.maxConcurrent),
})

function ConfigForm({ source, initial }: { source: Source; initial: FlowConfig }) {
  const [saved, setSaved] = useState(initial)
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const base = draftOf(saved)
  const dirty =
    draft.baseUrl !== base.baseUrl ||
    draft.apiKey !== '' ||
    draft.model !== base.model ||
    draft.api !== base.api ||
    draft.contextWindow !== base.contextWindow ||
    draft.maxTokens !== base.maxTokens ||
    draft.reasoning !== base.reasoning ||
    draft.thinkingLevel !== base.thinkingLevel ||
    draft.maxConcurrent !== base.maxConcurrent
  const missing = providerMissing(saved)
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setSuccess(false)
  }

  const save = async () => {
    const provider: Partial<ProviderConfig> & { apiKey?: string } = {
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      api: draft.api as ProviderConfig['api'],
      reasoning: draft.reasoning,
      thinkingLevel: draft.thinkingLevel,
      ...(draft.contextWindow.trim() ? { contextWindow: Number(draft.contextWindow) } : {}),
      ...(draft.maxTokens.trim() ? { maxTokens: Number(draft.maxTokens) } : {}),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    }
    setBusy(true)
    setError('')
    setSuccess(false)
    try {
      const updated = await source.configure({
        provider,
        maxConcurrent: Number(draft.maxConcurrent),
      })
      setSaved(updated)
      setDraft(draftOf(updated))
      setSuccess(true)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="max-w-2xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      {missing.length > 0 && (
        <Alert variant="warning">
          <AlertDescription role="status">
            模型 provider 还没配全（缺 {missing.join('、')}），启动运行会被拒绝。填好下面三项后即可执行
            Agent 节点。
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>模型 provider</CardTitle>
          <span className="text-xs text-muted-foreground">执行器 {saved.executor}</span>
        </CardHeader>
        <CardContent>
          <fieldset
            disabled={busy || source.mode === 'demo'}
            className="grid gap-4 disabled:opacity-70"
          >
            <div className="grid gap-1.5">
              <Label htmlFor="provider-base-url">服务地址</Label>
              <Input
                id="provider-base-url"
                value={draft.baseUrl}
                onChange={(event) => update('baseUrl', event.target.value)}
                placeholder="https://api.deepseek.com"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                OpenAI 兼容服务通常填到 <code>/v1</code> 为止，由协议决定实际路径。
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="provider-api-key">密钥</Label>
              <Input
                id="provider-api-key"
                type="password"
                value={draft.apiKey}
                onChange={(event) => update('apiKey', event.target.value)}
                placeholder={saved.provider.apiKeySet ? '已配置，留空则不修改' : '必填'}
                autoComplete="new-password"
              />
              {saved.provider.apiKeySet && (
                <p className="text-xs text-muted-foreground">密钥已保存，页面不回显。</p>
              )}
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="provider-model">模型标识</Label>
                <Input
                  id="provider-model"
                  value={draft.model}
                  onChange={(event) => update('model', event.target.value)}
                  placeholder="deepseek-chat"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="provider-api">协议</Label>
                <Select
                  id="provider-api"
                  value={draft.api}
                  onChange={(event) => update('api', event.target.value)}
                >
                  {PROVIDER_APIS.map((api) => (
                    <option key={api} value={api}>
                      {api}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="provider-context">上下文窗口</Label>
                <Input
                  id="provider-context"
                  type="number"
                  min={1}
                  value={draft.contextWindow}
                  onChange={(event) => update('contextWindow', event.target.value)}
                  placeholder="128000"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="provider-max-tokens">单次回复上限</Label>
                <Input
                  id="provider-max-tokens"
                  type="number"
                  min={1}
                  value={draft.maxTokens}
                  onChange={(event) => update('maxTokens', event.target.value)}
                  placeholder="8192"
                />
              </div>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="provider-thinking">思考强度</Label>
                <Select
                  id="provider-thinking"
                  value={draft.thinkingLevel}
                  onChange={(event) => update('thinkingLevel', event.target.value)}
                >
                  {THINKING_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="provider-reasoning">推理模型</Label>
                <Select
                  id="provider-reasoning"
                  value={draft.reasoning ? 'yes' : 'no'}
                  onChange={(event) => update('reasoning', event.target.value === 'yes')}
                >
                  <option value="no">否</option>
                  <option value="yes">是</option>
                </Select>
              </div>
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
                value={draft.maxConcurrent}
                onChange={(event) => update('maxConcurrent', event.target.value)}
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
        <CardFooter className="gap-2">
          <Button type="submit" variant="primary" disabled={!dirty || busy || source.mode === 'demo'}>
            <Save />
            保存配置
          </Button>
          {missing.length === 0 && <Badge variant="ok">可直接启动运行</Badge>}
        </CardFooter>
      </Card>
    </form>
  )
}
