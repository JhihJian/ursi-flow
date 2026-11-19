import { useState } from 'react'
import { Save } from 'lucide-react'
import { AsyncState, message, useLoad } from './main'
import type { FlowConfig, Source } from './data'

export function Config({ source }: { source: Source }) {
  const loaded = useLoad((signal) => source.config(signal), [source])
  return (
    <main>
      <div className="heading">
        <div>
          <h1>运行配置</h1>
          <small>新运行使用当前配置，已在运行的 Run 保留启动时的配置</small>
        </div>
      </div>
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
      className="panel"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <fieldset disabled={busy || source.mode === 'demo'}>
        <label className="block">
          执行器
          <input className="input mt-2" readOnly value={saved.executor} />
        </label>
        <label className="block">
          模型
          <input
            className="input mt-2"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="使用执行器默认模型"
          />
        </label>
        <label className="block">
          最大并发数
          <input
            className="input mt-2"
            type="number"
            required
            min={1}
            max={64}
            step={1}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="warning">
            {error}
          </p>
        )}
        {success && (
          <p role="status" className="success">
            配置已保存。
          </p>
        )}
        <button type="submit" className="primary" disabled={!dirty || busy}>
          <Save />
          保存配置
        </button>
      </fieldset>
      {source.mode === 'demo' && <p className="muted">演示数据不能修改配置。</p>}
    </form>
  )
}
