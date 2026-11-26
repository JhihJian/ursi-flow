import { useCallback, useEffect, useState } from 'react'
import { fetchConfig, type ServerConfig, type SessionRow } from '@/api'
import { useSessions } from '@/hooks/useSessions'
import { errorMessage } from '@/lib/ui'
import { Workspace } from '@/components/Workspace'

const ROOT_STORAGE_KEY = 'pi-sessions-web:root'

/** 根目录来自 URL、上次选择或服务端默认值，三者按序取第一个可用的。 */
function rememberedRoot(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('root')
  if (fromUrl) return fromUrl
  return window.localStorage.getItem(ROOT_STORAGE_KEY)
}

function rememberRoot(root: string): void {
  window.localStorage.setItem(ROOT_STORAGE_KEY, root)
  const url = new URL(window.location.href)
  url.searchParams.set('root', root)
  window.history.replaceState(null, '', url)
}

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [root, setRoot] = useState<string | null>(rememberedRoot)
  const [query, setQuery] = useState('')
  const [selectedRow, setSelectedRow] = useState<SessionRow | null>(null)

  useEffect(() => {
    void fetchConfig()
      .then(setConfig)
      .catch((failure: unknown) => setConfigError(errorMessage(failure)))
  }, [])

  // 没有记住过根就用服务端默认值；只补一次，不覆盖用户的选择。
  useEffect(() => {
    if (!root && config) {
      setRoot(config.defaultRoot)
      rememberRoot(config.defaultRoot)
    }
  }, [root, config])

  const { listing, loading, error, reload } = useSessions(root)

  const changeRoot = useCallback((next: string) => {
    rememberRoot(next)
    setSelectedRow(null)
    setQuery('')
    setRoot(next)
  }, [])

  if (configError) {
    return (
      <div className="boot">
        <p className="viewer-error">无法读取服务配置：{configError}</p>
        <p className="viewer-hint">确认服务端已启动（默认 http://127.0.0.1:30200）。</p>
      </div>
    )
  }

  if (!root) {
    return (
      <div className="boot">
        <p className="viewer-hint">读取中…</p>
      </div>
    )
  }

  return (
    <Workspace
      root={root}
      listing={listing}
      loading={loading}
      error={error}
      query={query}
      onQueryChange={setQuery}
      selectedRow={selectedRow}
      onSelect={setSelectedRow}
      onReload={reload}
      onRootChange={changeRoot}
      defaultRoot={config?.defaultRoot ?? root}
      suggestedRoots={config?.suggestedRoots ?? []}
    />
  )
}
